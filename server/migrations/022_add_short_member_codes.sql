-- 022: short member codes. New members get GP-101, GP-102, … counted separately in each gym.
-- Review before running in the Supabase SQL Editor. Safe to run more than once.
--
-- * Existing members keep their codes. This migration changes no existing row.
-- * A code someone typed in on purpose is kept. Only the automatic long codes (GP- followed by 12
--   letters/digits: made by the app, the import and the demo seed) are replaced by a short one.
-- * members.previous_member_code holds a replaced code (see 023, which is optional), and the app
--   searches it too, so an old printed code still finds the member.

ALTER TABLE public.members ADD COLUMN IF NOT EXISTS previous_member_code text;

CREATE TABLE IF NOT EXISTS public.gym_member_counters (
    gym_id uuid PRIMARY KEY REFERENCES public.gyms (id) ON DELETE CASCADE,
    last_number bigint NOT NULL
);
-- Only the trigger below uses it (no app or API access).
ALTER TABLE public.gym_member_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gym_member_counters FROM PUBLIC, anon, authenticated, service_role;

-- The next free short code for a gym (skips any code already taken in that gym).
CREATE OR REPLACE FUNCTION public.gympulse_next_member_code(p_gym_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_number bigint;
BEGIN
    LOOP
        INSERT INTO public.gym_member_counters AS c (gym_id, last_number) VALUES (p_gym_id, 101)
        ON CONFLICT (gym_id) DO UPDATE SET last_number = c.last_number + 1
        RETURNING last_number INTO v_number;
        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.members WHERE gym_id = p_gym_id AND member_code = 'GP-' || v_number);
    END LOOP;
    RETURN 'GP-' || v_number;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_next_member_code(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.gympulse_assign_member_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.gym_id IS NOT NULL AND (NEW.member_code IS NULL OR NEW.member_code ~ '^GP-[0-9A-F]{12}$') THEN
        NEW.member_code := public.gympulse_next_member_code(NEW.gym_id);
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_assign_member_code() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS members_assign_member_code ON public.members;
CREATE TRIGGER members_assign_member_code
    BEFORE INSERT ON public.members
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_assign_member_code();
