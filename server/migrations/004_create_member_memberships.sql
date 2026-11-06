CREATE TABLE IF NOT EXISTS public.member_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id uuid,
    member_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    plan_name text NOT NULL,
    duration_days integer NOT NULL,
    price numeric(12, 2) NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status text NOT NULL DEFAULT 'assigned',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT member_memberships_member_id_fkey
        FOREIGN KEY (member_id) REFERENCES public.members (id) ON DELETE RESTRICT,
    CONSTRAINT member_memberships_plan_id_fkey
        FOREIGN KEY (plan_id) REFERENCES public.membership_plans (id) ON DELETE RESTRICT,
    CONSTRAINT member_memberships_plan_name_nonempty CHECK (btrim(plan_name) <> ''),
    CONSTRAINT member_memberships_duration_positive CHECK (duration_days > 0),
    CONSTRAINT member_memberships_price_nonnegative CHECK (price >= 0),
    CONSTRAINT member_memberships_dates_valid CHECK (end_date >= start_date),
    CONSTRAINT member_memberships_status_valid CHECK (status IN ('assigned', 'cancelled'))
);

ALTER TABLE public.members
    ALTER COLUMN membership_start_date DROP NOT NULL,
    ALTER COLUMN membership_end_date DROP NOT NULL;

ALTER TABLE public.member_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_memberships FROM anon, authenticated;
GRANT ALL ON public.member_memberships TO service_role;

CREATE INDEX IF NOT EXISTS member_memberships_member_start_idx
    ON public.member_memberships (member_id, start_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS member_memberships_plan_idx
    ON public.member_memberships (plan_id);

CREATE INDEX IF NOT EXISTS member_memberships_gym_idx
    ON public.member_memberships (gym_id);

CREATE INDEX IF NOT EXISTS member_memberships_end_date_idx
    ON public.member_memberships (end_date);

CREATE OR REPLACE FUNCTION public.gympulse_set_member_memberships_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_memberships_set_updated_at ON public.member_memberships;
CREATE TRIGGER member_memberships_set_updated_at
    BEFORE UPDATE ON public.member_memberships
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_set_member_memberships_updated_at();

CREATE OR REPLACE FUNCTION public.gympulse_assign_member_plan(
    p_member_id uuid,
    p_plan_id uuid,
    p_start_date date
)
RETURNS SETOF public.member_memberships
LANGUAGE plpgsql
AS $$
DECLARE
    v_gym_id uuid;
    v_plan public.membership_plans%ROWTYPE;
    v_end_date date;
    v_membership public.member_memberships%ROWTYPE;
    v_legacy_start_date date;
    v_legacy_end_date date;
    v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
    IF p_start_date IS NULL THEN
        RAISE EXCEPTION 'Membership start date is required.' USING ERRCODE = '22004';
    END IF;

    SELECT gym_id
    INTO v_gym_id
    FROM public.members
    WHERE id = p_member_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member not found.' USING ERRCODE = 'P0002';
    END IF;

    SELECT *
    INTO v_plan
    FROM public.membership_plans
    WHERE id = p_plan_id
      AND gym_id IS NOT DISTINCT FROM v_gym_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Plan not found.' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_plan.is_active THEN
        RAISE EXCEPTION 'Only active plans can be assigned.' USING ERRCODE = 'P0001';
    END IF;

    v_end_date := p_start_date + v_plan.duration_days - 1;

    IF EXISTS (
        SELECT 1
        FROM public.member_memberships
        WHERE member_id = p_member_id
          AND status <> 'cancelled'
          AND start_date <= v_end_date
          AND end_date >= p_start_date
    ) THEN
        RAISE EXCEPTION 'This member already has a membership during those dates.'
            USING ERRCODE = '23P01';
    END IF;

    INSERT INTO public.member_memberships (
        gym_id, member_id, plan_id, plan_name, duration_days, price, start_date, end_date
    )
    VALUES (
        v_gym_id, p_member_id, v_plan.id, v_plan.name, v_plan.duration_days, v_plan.price, p_start_date, v_end_date
    )
    RETURNING * INTO v_membership;

    SELECT start_date, end_date
    INTO v_legacy_start_date, v_legacy_end_date
    FROM public.member_memberships
    WHERE member_id = p_member_id
      AND gym_id IS NOT DISTINCT FROM v_gym_id
      AND status <> 'cancelled'
      AND end_date >= v_today
    ORDER BY
        CASE WHEN start_date <= v_today THEN 0 ELSE 1 END,
        start_date ASC,
        created_at ASC
    LIMIT 1;

    UPDATE public.members
    SET membership_start_date = v_legacy_start_date,
        membership_end_date = v_legacy_end_date,
        updated_at = now()
    WHERE id = p_member_id;

    RETURN NEXT v_membership;
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_assign_member_plan(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_assign_member_plan(uuid, uuid, date) TO service_role;
