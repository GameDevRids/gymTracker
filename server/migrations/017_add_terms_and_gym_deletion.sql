-- 017: agreeing to the Terms and Privacy Policy, and deleting a gym account.
-- Review before running in the Supabase SQL Editor. Safe to run more than once.
--
-- Terms: each user agrees once per version of the Terms + Privacy Policy (one version number
-- covers both). The row records who agreed, to which version, and when. Only the server
-- (service role) writes it; nobody can change or remove an agreement afterwards, except that
-- it goes when the user's account is deleted.
--
-- Deleting a gym: the owner asks, the gym is locked straight away, and 7 days later the server
-- calls gympulse_delete_gym, which erases every row of that gym in one transaction. Until then
-- the owner can cancel. The function refuses a gym whose 7 days have not passed, so a mistake
-- in the server cannot erase a gym early. Member photos (Storage) and the users' sign-in
-- accounts (Supabase Auth) are removed by the server, not here.

-- ---------- Terms agreements ----------
CREATE TABLE IF NOT EXISTS public.terms_acceptances (
    user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    terms_version text NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, terms_version),
    CONSTRAINT terms_acceptances_version_format CHECK (terms_version ~ '^\d{4}-\d{2}-\d{2}$')
);

ALTER TABLE public.terms_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.terms_acceptances FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.terms_acceptances TO service_role;

-- ---------- gyms: deletion request ----------
ALTER TABLE public.gyms
    ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz,
    ADD COLUMN IF NOT EXISTS deletion_requested_by uuid,
    ADD COLUMN IF NOT EXISTS deletion_scheduled_for timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gyms_deletion_fields_together') THEN
        -- All three are set together (a request) or all empty (no request / cancelled).
        ALTER TABLE public.gyms ADD CONSTRAINT gyms_deletion_fields_together CHECK (
            (deletion_requested_at IS NULL) = (deletion_scheduled_for IS NULL)
            AND (deletion_requested_at IS NULL) = (deletion_requested_by IS NULL)
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gyms_deletion_after_7_days') THEN
        ALTER TABLE public.gyms ADD CONSTRAINT gyms_deletion_after_7_days CHECK (
            deletion_scheduled_for IS NULL OR deletion_scheduled_for >= deletion_requested_at + interval '7 days'
        );
    END IF;
END;
$$;

-- The server's hourly sweep looks for gyms that are due.
CREATE INDEX IF NOT EXISTS gyms_deletion_scheduled_for_idx
    ON public.gyms (deletion_scheduled_for) WHERE deletion_scheduled_for IS NOT NULL;

-- ---------- Append-only guards: allow only the gym deletion below ----------
-- Consent history stays append-only for every role; the one exception is erasing a whole gym
-- inside gympulse_delete_gym (which sets gympulse.allow_gym_delete for its own transaction).
-- TRUNCATE is still refused.
CREATE OR REPLACE FUNCTION public.gympulse_consent_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('gympulse.allow_gym_delete', true) = OLD.gym_id::text THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Consent history is append-only.' USING ERRCODE = '42501';
END;
$$;

-- Payments: the demo reset (011) or the deletion of that payment's own gym.
CREATE OR REPLACE FUNCTION public.gympulse_payments_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('gympulse.allow_payment_reset', true) = 'on'
        OR current_setting('gympulse.allow_gym_delete', true) = OLD.gym_id::text THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Payments cannot be deleted; receipt numbers must stay complete.' USING ERRCODE = '42501';
END;
$$;

-- ---------- Erasing a gym ----------
-- Returns the user ids that belonged to the gym, so the server can remove sign-in accounts
-- that no longer belong to any gym.
CREATE OR REPLACE FUNCTION public.gympulse_delete_gym(p_gym_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_gym public.gyms%ROWTYPE;
    v_users uuid[];
BEGIN
    IF p_gym_id IS NULL THEN
        RAISE EXCEPTION 'Gym is required.' USING ERRCODE = '22004';
    END IF;
    SELECT * INTO v_gym FROM public.gyms WHERE id = p_gym_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Gym not found.' USING ERRCODE = 'P0002';
    END IF;
    IF v_gym.deletion_scheduled_for IS NULL OR v_gym.deletion_scheduled_for > now() THEN
        RAISE EXCEPTION 'This gym is not due for deletion.' USING ERRCODE = '55000';
    END IF;

    SELECT coalesce(array_agg(user_id), ARRAY[]::uuid[]) INTO v_users
        FROM public.gym_users WHERE gym_id = p_gym_id;

    -- Only for this gym, and only until the end of this transaction.
    PERFORM set_config('gympulse.allow_gym_delete', p_gym_id::text, true);

    -- Children before parents (several links are ON DELETE RESTRICT on purpose).
    DELETE FROM public.attendance WHERE gym_id = p_gym_id;
    DELETE FROM public.whatsapp_messages WHERE gym_id = p_gym_id;
    DELETE FROM public.payments WHERE gym_id = p_gym_id;
    DELETE FROM public.member_consent_events WHERE gym_id = p_gym_id;
    DELETE FROM public.member_memberships WHERE gym_id = p_gym_id;
    DELETE FROM public.member_devices WHERE gym_id = p_gym_id;
    DELETE FROM public.members WHERE gym_id = p_gym_id;
    DELETE FROM public.membership_plans WHERE gym_id = p_gym_id;
    DELETE FROM public.gym_message_templates WHERE gym_id = p_gym_id;
    DELETE FROM public.gym_receipt_counters WHERE gym_id = p_gym_id;
    DELETE FROM public.gym_settings WHERE gym_id = p_gym_id;
    DELETE FROM public.gym_users WHERE gym_id = p_gym_id;
    DELETE FROM public.gyms WHERE id = p_gym_id;

    PERFORM set_config('gympulse.allow_gym_delete', '', true);
    RETURN v_users;
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_delete_gym(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_delete_gym(uuid) TO service_role;
