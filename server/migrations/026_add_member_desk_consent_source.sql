-- WhatsApp consent the member gives themselves when they are added (Add member): the staff phone
-- shows "<Gym name> may send you WhatsApp messages about your membership. [I agree] [No thanks]"
-- and the member taps it. Recorded with source 'member_desk'. Photo consent is not changed.
-- Nothing else changes: no new tables or columns, RLS and gym isolation are as before, and
-- existing history is untouched.

-- 1. The consent history accepts the new source.
ALTER TABLE public.member_consent_events DROP CONSTRAINT IF EXISTS member_consent_events_source_valid;
ALTER TABLE public.member_consent_events ADD CONSTRAINT member_consent_events_source_valid CHECK (
    (channel = 'whatsapp' AND source IN ('staff_form', 'csv_import', 'member_reply_stop', 'enquiry', 'member_desk'))
    OR (channel = 'photo' AND source IN ('desk', 'poster_page')));

-- 2. The consent function accepts it too (same as migration 024, with 'member_desk' added).
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
    IF p_source IS NULL OR p_source NOT IN ('staff_form', 'csv_import', 'member_reply_stop', 'enquiry', 'member_desk') THEN
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
