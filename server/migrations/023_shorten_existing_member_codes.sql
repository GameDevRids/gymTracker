-- 023 (OPTIONAL): shorten the long codes members already have, oldest member first in each gym
-- (GP-D99D8ECC34DB becomes GP-101, GP-102, …). Run it after 022, ideally before many new members are
-- added, so the oldest members get the lowest numbers. Safe to run more than once.
--
-- * The old code is kept in previous_member_code, and the app searches it, so an old printed code
--   still finds the member.
-- * QR check-in is not affected: cards use the QR token, not the code. A printed card shows the old
--   code until it is printed again.
-- * Codes someone typed in on purpose are left alone.

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT id, gym_id, member_code FROM public.members
        WHERE gym_id IS NOT NULL AND member_code ~ '^GP-[0-9A-F]{12}$'
        ORDER BY gym_id, created_at, id
    LOOP
        UPDATE public.members
        SET previous_member_code = r.member_code,
            member_code = public.gympulse_next_member_code(r.gym_id),
            updated_at = now()
        WHERE id = r.id;
    END LOOP;
END;
$$;
