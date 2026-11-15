-- 018: emptying the demo gym before it is filled again with fictional data.
-- Review before running in the Supabase SQL Editor. Safe to run more than once.
--
-- The demo gym is a normal gym in a separate, disposable Supabase project, filled by
-- server/scripts/seed-demo.js. After people have tried the demo it has check-ins, linked phones,
-- WhatsApp logs and consent history, which ordinary deletes refuse (on purpose). This function
-- empties one gym's members, plans, memberships, payments and visits in one transaction, and
-- keeps the gym itself, its settings, message templates and sign-in accounts.
--
-- Only the service role can call it, and only with the confirmation text 'RESET DEMO <gym id>',
-- so it cannot be called by accident with just an id. GymPulse's server never calls it; only
-- the seed script does, and that refuses to run unless ALLOW_SEED=true and the DEMO_* settings
-- point at the demo project. Member photos in Storage are not touched (seeded members have none;
-- run scripts/sweep-orphan-photos.js in the demo project if visitors added some).

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
