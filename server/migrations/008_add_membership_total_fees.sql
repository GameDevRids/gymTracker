ALTER TABLE public.member_memberships
    ADD COLUMN IF NOT EXISTS total_fees numeric(12, 2);

UPDATE public.member_memberships
SET total_fees = price
WHERE total_fees IS NULL;

ALTER TABLE public.member_memberships
    ALTER COLUMN total_fees SET DEFAULT 0,
    ALTER COLUMN total_fees SET NOT NULL;

ALTER TABLE public.member_memberships
    ADD CONSTRAINT member_memberships_total_fees_nonnegative
    CHECK (total_fees >= 0);

DROP FUNCTION IF EXISTS public.gympulse_assign_member_plan(uuid, uuid, date, uuid);

CREATE OR REPLACE FUNCTION public.gympulse_assign_member_plan(
    p_member_id uuid,
    p_plan_id uuid,
    p_start_date date,
    p_gym_id uuid,
    p_total_fees numeric
)
RETURNS SETOF public.member_memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_plan public.membership_plans%ROWTYPE;
    v_end_date date;
    v_membership public.member_memberships%ROWTYPE;
    v_legacy_start_date date;
    v_legacy_end_date date;
    v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
    IF p_start_date IS NULL OR p_gym_id IS NULL THEN
        RAISE EXCEPTION 'Membership start date and gym are required.' USING ERRCODE = '22004';
    END IF;
    IF p_total_fees IS NOT NULL AND p_total_fees < 0 THEN
        RAISE EXCEPTION 'Membership fees cannot be negative.' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM public.members
    WHERE id = p_member_id AND gym_id = p_gym_id AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member not found.' USING ERRCODE = 'P0002';
    END IF;
    SELECT * INTO v_plan FROM public.membership_plans
    WHERE id = p_plan_id AND gym_id = p_gym_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Plan not found.' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_plan.is_active THEN
        RAISE EXCEPTION 'Only active plans can be assigned.' USING ERRCODE = 'P0001';
    END IF;
    v_end_date := p_start_date + v_plan.duration_days - 1;
    IF EXISTS (
        SELECT 1 FROM public.member_memberships
        WHERE gym_id = p_gym_id AND member_id = p_member_id AND status <> 'cancelled'
          AND start_date <= v_end_date AND end_date >= p_start_date
    ) THEN
        RAISE EXCEPTION 'This member already has a membership during those dates.' USING ERRCODE = '23P01';
    END IF;
    INSERT INTO public.member_memberships (
        gym_id, member_id, plan_id, plan_name, duration_days, price, total_fees, start_date, end_date
    ) VALUES (
        p_gym_id, p_member_id, v_plan.id, v_plan.name, v_plan.duration_days,
        v_plan.price, COALESCE(p_total_fees, v_plan.price), p_start_date, v_end_date
    ) RETURNING * INTO v_membership;
    SELECT start_date, end_date INTO v_legacy_start_date, v_legacy_end_date
    FROM public.member_memberships
    WHERE gym_id = p_gym_id AND member_id = p_member_id AND status <> 'cancelled' AND end_date >= v_today
    ORDER BY CASE WHEN start_date <= v_today THEN 0 ELSE 1 END, start_date ASC, created_at ASC
    LIMIT 1;
    UPDATE public.members SET membership_start_date = v_legacy_start_date,
        membership_end_date = v_legacy_end_date, updated_at = now()
    WHERE id = p_member_id AND gym_id = p_gym_id;
    RETURN NEXT v_membership;
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_assign_member_plan(uuid, uuid, date, uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_assign_member_plan(uuid, uuid, date, uuid, numeric) TO service_role;
