-- 009: emergency contact, follow-up status and WhatsApp consent with an append-only history.
-- Existing members start without consent and without history; nobody is assumed to have opted in.

ALTER TABLE public.members
    ADD COLUMN IF NOT EXISTS emergency_contact text,
    ADD COLUMN IF NOT EXISTS follow_up_status text NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS whatsapp_opt_in boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at timestamptz,
    ADD COLUMN IF NOT EXISTS whatsapp_opt_out_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_emergency_contact_length') THEN
        ALTER TABLE public.members
            ADD CONSTRAINT members_emergency_contact_length
            CHECK (emergency_contact IS NULL OR char_length(emergency_contact) <= 32);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_follow_up_status_valid') THEN
        ALTER TABLE public.members
            ADD CONSTRAINT members_follow_up_status_valid
            CHECK (follow_up_status IN ('pending', 'contacted', 'returned', 'renewed', 'not interested'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_whatsapp_opt_in_has_time') THEN
        ALTER TABLE public.members
            ADD CONSTRAINT members_whatsapp_opt_in_has_time
            CHECK (NOT whatsapp_opt_in OR whatsapp_opt_in_at IS NOT NULL);
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.member_consent_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id uuid NOT NULL,
    member_id uuid NOT NULL,
    channel text NOT NULL,
    action text NOT NULL,
    source text NOT NULL,
    -- Kept as a plain id, not a foreign key, so the record survives if that login is removed.
    recorded_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT member_consent_events_gym_id_fkey
        FOREIGN KEY (gym_id) REFERENCES public.gyms (id) ON DELETE RESTRICT,
    CONSTRAINT member_consent_events_gym_member_fkey
        FOREIGN KEY (gym_id, member_id) REFERENCES public.members (gym_id, id) ON DELETE RESTRICT,
    CONSTRAINT member_consent_events_channel_valid CHECK (channel IN ('whatsapp')),
    CONSTRAINT member_consent_events_action_valid CHECK (action IN ('granted', 'withdrawn')),
    CONSTRAINT member_consent_events_source_valid
        CHECK (source IN ('staff_form', 'csv_import', 'member_reply_stop'))
);

CREATE INDEX IF NOT EXISTS member_consent_events_gym_member_created_idx
    ON public.member_consent_events (gym_id, member_id, created_at);

ALTER TABLE public.member_consent_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_consent_events FROM PUBLIC, anon, authenticated, service_role;
-- Owners may read their own gym's history; nobody writes it directly. Events are only added
-- by the consent trigger below, and the table rejects updates and deletes for every role.
GRANT SELECT ON public.member_consent_events TO authenticated;
GRANT SELECT ON public.member_consent_events TO service_role;

DROP POLICY IF EXISTS member_consent_events_select_own_gym ON public.member_consent_events;
CREATE POLICY member_consent_events_select_own_gym ON public.member_consent_events
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));

CREATE OR REPLACE FUNCTION public.gympulse_consent_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Consent history is append-only.' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS member_consent_events_append_only ON public.member_consent_events;
CREATE TRIGGER member_consent_events_append_only
    BEFORE UPDATE OR DELETE ON public.member_consent_events
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_consent_events_append_only();

DROP TRIGGER IF EXISTS member_consent_events_no_truncate ON public.member_consent_events;
CREATE TRIGGER member_consent_events_no_truncate
    BEFORE TRUNCATE ON public.member_consent_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.gympulse_consent_events_append_only();

-- Every change to members.whatsapp_opt_in goes through this trigger, which sets the timestamps
-- and writes exactly one history event in the same statement. A change is refused unless
-- gympulse_set_member_whatsapp_consent supplied a source, so state and history cannot disagree.
CREATE OR REPLACE FUNCTION public.gympulse_track_member_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_source text := nullif(current_setting('gympulse.consent_source', true), '');
    v_recorded_by uuid := nullif(current_setting('gympulse.consent_recorded_by', true), '')::uuid;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.whatsapp_opt_in THEN
            RAISE EXCEPTION 'New members start without WhatsApp consent; record consent separately.' USING ERRCODE = '23514';
        END IF;
        NEW.whatsapp_opt_in_at := NULL;
        NEW.whatsapp_opt_out_at := NULL;
        RETURN NEW;
    END IF;

    IF NEW.whatsapp_opt_in IS NOT DISTINCT FROM OLD.whatsapp_opt_in THEN
        -- The timestamps only change together with the consent itself.
        NEW.whatsapp_opt_in_at := OLD.whatsapp_opt_in_at;
        NEW.whatsapp_opt_out_at := OLD.whatsapp_opt_out_at;
        RETURN NEW;
    END IF;

    IF v_source IS NULL THEN
        RAISE EXCEPTION 'Change WhatsApp consent with gympulse_set_member_whatsapp_consent.' USING ERRCODE = '42501';
    END IF;

    IF NEW.whatsapp_opt_in THEN
        NEW.whatsapp_opt_in_at := now();
        NEW.whatsapp_opt_out_at := OLD.whatsapp_opt_out_at;
    ELSE
        NEW.whatsapp_opt_in_at := OLD.whatsapp_opt_in_at;
        NEW.whatsapp_opt_out_at := now();
    END IF;

    INSERT INTO public.member_consent_events (gym_id, member_id, channel, action, source, recorded_by, created_at)
    VALUES (NEW.gym_id, NEW.id, 'whatsapp', CASE WHEN NEW.whatsapp_opt_in THEN 'granted' ELSE 'withdrawn' END,
        v_source, v_recorded_by, now());
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_track_member_consent() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS members_track_whatsapp_consent ON public.members;
CREATE TRIGGER members_track_whatsapp_consent
    BEFORE INSERT OR UPDATE ON public.members
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_track_member_consent();

CREATE OR REPLACE FUNCTION public.gympulse_set_member_whatsapp_consent(
    p_gym_id uuid,
    p_member_id uuid,
    p_opt_in boolean,
    p_source text,
    p_recorded_by uuid
)
RETURNS SETOF public.members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_member public.members%ROWTYPE;
BEGIN
    IF p_gym_id IS NULL OR p_member_id IS NULL OR p_opt_in IS NULL THEN
        RAISE EXCEPTION 'Gym, member and consent choice are required.' USING ERRCODE = '22004';
    END IF;
    IF p_source IS NULL OR p_source NOT IN ('staff_form', 'csv_import', 'member_reply_stop') THEN
        RAISE EXCEPTION 'Unknown consent source.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_member FROM public.members
    WHERE id = p_member_id AND gym_id = p_gym_id AND archived_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member not found.' USING ERRCODE = 'P0002';
    END IF;

    -- Repeating the current choice changes nothing and adds no history.
    IF v_member.whatsapp_opt_in = p_opt_in THEN
        RETURN NEXT v_member;
        RETURN;
    END IF;

    PERFORM set_config('gympulse.consent_source', p_source, true);
    PERFORM set_config('gympulse.consent_recorded_by', coalesce(p_recorded_by::text, ''), true);
    UPDATE public.members
    SET whatsapp_opt_in = p_opt_in, updated_at = now()
    WHERE id = p_member_id AND gym_id = p_gym_id
    RETURNING * INTO v_member;
    -- Clear the markers so no later statement in this transaction can reuse them.
    PERFORM set_config('gympulse.consent_source', '', true);
    PERFORM set_config('gympulse.consent_recorded_by', '', true);

    RETURN NEXT v_member;
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_set_member_whatsapp_consent(uuid, uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_set_member_whatsapp_consent(uuid, uuid, boolean, text, uuid) TO service_role;
