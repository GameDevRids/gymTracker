-- 024: enquiries (people who visited and might join). Review before running in the Supabase SQL
-- Editor. Safe to run more than once.
--
-- * One row per enquiry, always inside one gym: the plan they asked about and the member they became
--   must belong to the same gym (composite keys), and gym users can read only their own gym's rows.
--   The app writes through the server (service role), like every other table.
-- * The same phone can be an open enquiry (new or contacted) only once per gym.
-- * Privacy: an enquiry that did not join is deleted 90 days after it was last changed
--   (gympulse_purge_old_enquiries). Nothing about members is touched.
-- * WhatsApp consent the visitor gave at the desk can be carried over when they join: the member's
--   consent history then says "enquiry" instead of "staff form".

CREATE TABLE IF NOT EXISTS public.enquiries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id uuid NOT NULL REFERENCES public.gyms (id) ON DELETE CASCADE,
    full_name text NOT NULL,
    phone text NOT NULL,                       -- +91 and 10 digits
    interest_plan_id uuid,                     -- a plan of this gym, or null
    interest_text text,                        -- "Not sure", or what they said, when no plan fits
    source text NOT NULL DEFAULT 'walk_in',
    note text,
    stage text NOT NULL DEFAULT 'new',
    follow_up_on date,
    last_contacted_at timestamptz,
    whatsapp_consent boolean NOT NULL DEFAULT false,
    whatsapp_consent_at timestamptz,
    joined_member_id uuid,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT enquiries_plan_fkey FOREIGN KEY (gym_id, interest_plan_id)
        REFERENCES public.membership_plans (gym_id, id) ON DELETE SET NULL (interest_plan_id),
    CONSTRAINT enquiries_member_fkey FOREIGN KEY (gym_id, joined_member_id)
        REFERENCES public.members (gym_id, id) ON DELETE SET NULL (joined_member_id),
    CONSTRAINT enquiries_name_valid CHECK (char_length(btrim(full_name)) BETWEEN 1 AND 120),
    CONSTRAINT enquiries_phone_valid CHECK (phone ~ '^\+91[6-9][0-9]{9}$'),
    CONSTRAINT enquiries_interest_text_length CHECK (interest_text IS NULL OR char_length(interest_text) <= 120),
    CONSTRAINT enquiries_note_length CHECK (note IS NULL OR char_length(note) <= 500),
    CONSTRAINT enquiries_source_valid CHECK (source IN ('walk_in', 'instagram', 'friend', 'other')),
    CONSTRAINT enquiries_stage_valid CHECK (stage IN ('new', 'contacted', 'joined', 'not_interested')),
    CONSTRAINT enquiries_consent_date CHECK (whatsapp_consent = (whatsapp_consent_at IS NOT NULL)),
    CONSTRAINT enquiries_joined_member CHECK (joined_member_id IS NULL OR stage = 'joined')
);

-- The same phone is an open enquiry only once per gym.
CREATE UNIQUE INDEX IF NOT EXISTS enquiries_one_open_per_phone
    ON public.enquiries (gym_id, phone) WHERE stage IN ('new', 'contacted');
-- "Follow up today" and the badge.
CREATE INDEX IF NOT EXISTS enquiries_follow_up_idx
    ON public.enquiries (gym_id, follow_up_on) WHERE stage IN ('new', 'contacted');
CREATE INDEX IF NOT EXISTS enquiries_gym_created_idx ON public.enquiries (gym_id, created_at DESC);

-- updated_at moves on every change, so "90 days after the last update" is exact.
CREATE OR REPLACE FUNCTION public.gympulse_touch_enquiry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_touch_enquiry() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS enquiries_touch ON public.enquiries;
CREATE TRIGGER enquiries_touch BEFORE UPDATE ON public.enquiries
    FOR EACH ROW EXECUTE FUNCTION public.gympulse_touch_enquiry();

ALTER TABLE public.enquiries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.enquiries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.enquiries TO authenticated;
GRANT ALL ON public.enquiries TO service_role;
DROP POLICY IF EXISTS enquiries_select_own_gym ON public.enquiries;
CREATE POLICY enquiries_select_own_gym ON public.enquiries
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));

-- Deletes enquiries that did not join and have not changed for 90 days. p_gym_id null = every gym.
-- Returns how many were deleted. Members are never touched.
CREATE OR REPLACE FUNCTION public.gympulse_purge_old_enquiries(p_gym_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count integer;
BEGIN
    DELETE FROM public.enquiries
    WHERE (p_gym_id IS NULL OR gym_id = p_gym_id)
      AND stage <> 'joined'
      AND updated_at < now() - interval '90 days';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_purge_old_enquiries(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_purge_old_enquiries(uuid) TO service_role;

-- The enquiry follow-up message is a template like the welcome and expiry messages (Settings > Messages).
ALTER TABLE public.gym_message_templates DROP CONSTRAINT IF EXISTS gym_message_templates_key_valid;
ALTER TABLE public.gym_message_templates ADD CONSTRAINT gym_message_templates_key_valid
    CHECK (template_key IN ('welcome', 'expiry_reminder', 'enquiry_followup'));

-- A member who joins from an enquiry keeps the WhatsApp consent they gave at the desk, recorded as such.
ALTER TABLE public.member_consent_events DROP CONSTRAINT IF EXISTS member_consent_events_source_valid;
ALTER TABLE public.member_consent_events ADD CONSTRAINT member_consent_events_source_valid CHECK (
    (channel = 'whatsapp' AND source IN ('staff_form', 'csv_import', 'member_reply_stop', 'enquiry'))
    OR (channel = 'photo' AND source IN ('desk', 'poster_page')));


-- The consent function accepts the new source (same as migration 009, with 'enquiry' added).
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
    IF p_source IS NULL OR p_source NOT IN ('staff_form', 'csv_import', 'member_reply_stop', 'enquiry') THEN
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

-- Resetting the demo gym also clears its enquiries (same as migration 018, with one line added).
CREATE OR REPLACE FUNCTION public.gympulse_reset_demo_gym(p_gym_id uuid, p_confirm text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_gym_id IS NULL OR p_confirm IS DISTINCT FROM 'RESET DEMO ' || p_gym_id::text THEN
        RAISE EXCEPTION 'Confirm with the text RESET DEMO <gym id>.' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.gyms WHERE id = p_gym_id) THEN
        RAISE EXCEPTION 'Gym not found.' USING ERRCODE = 'P0002';
    END IF;

    -- Uses the same one-gym, one-transaction allowance as gym deletion (migration 017).
    PERFORM set_config('gympulse.allow_gym_delete', p_gym_id::text, true);
    DELETE FROM public.enquiries WHERE gym_id = p_gym_id;
    DELETE FROM public.attendance WHERE gym_id = p_gym_id;
    DELETE FROM public.whatsapp_messages WHERE gym_id = p_gym_id;
    DELETE FROM public.payments WHERE gym_id = p_gym_id;
    DELETE FROM public.gym_receipt_counters WHERE gym_id = p_gym_id;
    DELETE FROM public.member_consent_events WHERE gym_id = p_gym_id;
    DELETE FROM public.member_memberships WHERE gym_id = p_gym_id;
    DELETE FROM public.member_devices WHERE gym_id = p_gym_id;
    DELETE FROM public.members WHERE gym_id = p_gym_id;
    DELETE FROM public.membership_plans WHERE gym_id = p_gym_id;
    PERFORM set_config('gympulse.allow_gym_delete', '', true);
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_reset_demo_gym(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_reset_demo_gym(uuid, text) TO service_role;
