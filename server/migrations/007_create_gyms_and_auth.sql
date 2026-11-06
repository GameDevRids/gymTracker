CREATE TABLE IF NOT EXISTS public.gyms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (btrim(name) <> ''),
    owner_user_id uuid REFERENCES auth.users (id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gyms ALTER COLUMN owner_user_id DROP NOT NULL;
ALTER TABLE public.gyms
    ADD CONSTRAINT gyms_unowned_default_only
    CHECK (owner_user_id IS NOT NULL OR name = 'GymPulse Default Gym');

CREATE TABLE IF NOT EXISTS public.gym_users (
    gym_id uuid NOT NULL REFERENCES public.gyms (id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'staff')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (gym_id, user_id),
    CONSTRAINT gym_users_user_id_unique UNIQUE (user_id)
);

DO $$
DECLARE
    v_owner_id uuid;
    v_gym_id uuid;
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.members WHERE gym_id IS NULL
        UNION ALL SELECT 1 FROM public.membership_plans WHERE gym_id IS NULL
        UNION ALL SELECT 1 FROM public.member_memberships WHERE gym_id IS NULL
        UNION ALL SELECT 1 FROM public.payments WHERE gym_id IS NULL
    ) THEN
        SELECT id INTO v_owner_id FROM auth.users ORDER BY created_at, id LIMIT 1;

        INSERT INTO public.gyms (name, owner_user_id)
        VALUES ('GymPulse Default Gym', v_owner_id)
        RETURNING id INTO v_gym_id;
        IF v_owner_id IS NOT NULL THEN
            INSERT INTO public.gym_users (gym_id, user_id, role)
            VALUES (v_gym_id, v_owner_id, 'owner');
        END IF;

        UPDATE public.members SET gym_id = v_gym_id WHERE gym_id IS NULL;
        UPDATE public.membership_plans SET gym_id = v_gym_id WHERE gym_id IS NULL;
        UPDATE public.member_memberships SET gym_id = v_gym_id WHERE gym_id IS NULL;
        UPDATE public.payments SET gym_id = v_gym_id WHERE gym_id IS NULL;
    END IF;
END;
$$;

ALTER TABLE public.members
    ALTER COLUMN gym_id SET NOT NULL,
    DROP CONSTRAINT IF EXISTS members_gym_id_member_code_key;
ALTER TABLE public.membership_plans ALTER COLUMN gym_id SET NOT NULL;
ALTER TABLE public.member_memberships ALTER COLUMN gym_id SET NOT NULL;
ALTER TABLE public.payments ALTER COLUMN gym_id SET NOT NULL;

ALTER TABLE public.members
    ADD CONSTRAINT members_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms (id) ON DELETE CASCADE;
ALTER TABLE public.membership_plans
    ADD CONSTRAINT membership_plans_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms (id) ON DELETE CASCADE;
ALTER TABLE public.member_memberships
    ADD CONSTRAINT member_memberships_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms (id) ON DELETE CASCADE;
ALTER TABLE public.payments
    ADD CONSTRAINT payments_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms (id) ON DELETE CASCADE;

ALTER TABLE public.members ADD CONSTRAINT members_gym_id_id_key UNIQUE (gym_id, id);
ALTER TABLE public.membership_plans ADD CONSTRAINT membership_plans_gym_id_id_key UNIQUE (gym_id, id);
ALTER TABLE public.member_memberships ADD CONSTRAINT member_memberships_gym_id_id_key UNIQUE (gym_id, id);
ALTER TABLE public.member_memberships
    ADD CONSTRAINT member_memberships_gym_member_fkey
        FOREIGN KEY (gym_id, member_id) REFERENCES public.members (gym_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT member_memberships_gym_plan_fkey
        FOREIGN KEY (gym_id, plan_id) REFERENCES public.membership_plans (gym_id, id) ON DELETE RESTRICT;
ALTER TABLE public.payments
    ADD CONSTRAINT payments_gym_member_fkey
        FOREIGN KEY (gym_id, member_id) REFERENCES public.members (gym_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT payments_gym_membership_fkey
        FOREIGN KEY (gym_id, membership_id) REFERENCES public.member_memberships (gym_id, id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS public.members_unassigned_member_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS members_gym_member_code_key
    ON public.members (gym_id, member_code);
CREATE INDEX IF NOT EXISTS members_gym_id_idx ON public.members (gym_id);
CREATE INDEX IF NOT EXISTS membership_plans_gym_id_idx ON public.membership_plans (gym_id);
CREATE INDEX IF NOT EXISTS member_memberships_gym_id_idx ON public.member_memberships (gym_id);
CREATE INDEX IF NOT EXISTS payments_gym_id_idx ON public.payments (gym_id);

CREATE OR REPLACE FUNCTION public.gympulse_user_has_gym(p_gym_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.gym_users
        WHERE gym_id = p_gym_id AND user_id = auth.uid()
    );
$$;

REVOKE ALL ON FUNCTION public.gympulse_user_has_gym(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gympulse_user_has_gym(uuid) TO authenticated;

ALTER TABLE public.gyms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gym_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.gyms, public.gym_users, public.members, public.membership_plans,
    public.member_memberships, public.payments FROM anon, authenticated;
GRANT SELECT ON public.gyms, public.gym_users, public.members, public.membership_plans,
    public.member_memberships, public.payments TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.members, public.membership_plans,
    public.member_memberships, public.payments TO authenticated;
GRANT ALL ON public.gyms, public.gym_users, public.members, public.membership_plans,
    public.member_memberships, public.payments TO service_role;

CREATE OR REPLACE FUNCTION public.gympulse_create_or_claim_gym(
    p_name text,
    p_owner_user_id uuid
)
RETURNS SETOF public.gyms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_gym public.gyms%ROWTYPE;
BEGIN
    IF p_name IS NULL OR btrim(p_name) = '' OR p_owner_user_id IS NULL THEN
        RAISE EXCEPTION 'Gym name and owner are required.' USING ERRCODE = '22004';
    END IF;

    UPDATE public.gyms
    SET name = btrim(p_name), owner_user_id = p_owner_user_id
    WHERE id = (
        SELECT id
        FROM public.gyms
        WHERE owner_user_id IS NULL AND name = 'GymPulse Default Gym'
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING * INTO v_gym;

    IF NOT FOUND THEN
        INSERT INTO public.gyms (name, owner_user_id)
        VALUES (btrim(p_name), p_owner_user_id)
        RETURNING * INTO v_gym;
    END IF;

    INSERT INTO public.gym_users (gym_id, user_id, role)
    VALUES (v_gym.id, p_owner_user_id, 'owner');

    RETURN NEXT v_gym;
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_create_or_claim_gym(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_create_or_claim_gym(text, uuid) TO service_role;

CREATE POLICY gyms_select_own ON public.gyms
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(id));
CREATE POLICY gym_users_select_own ON public.gym_users
    FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY members_select_own_gym ON public.members
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));
CREATE POLICY members_insert_own_gym ON public.members
    FOR INSERT TO authenticated WITH CHECK (public.gympulse_user_has_gym(gym_id));
CREATE POLICY members_update_own_gym ON public.members
    FOR UPDATE TO authenticated USING (public.gympulse_user_has_gym(gym_id))
    WITH CHECK (public.gympulse_user_has_gym(gym_id));
CREATE POLICY members_delete_own_gym ON public.members
    FOR DELETE TO authenticated USING (public.gympulse_user_has_gym(gym_id));

CREATE POLICY membership_plans_select_own_gym ON public.membership_plans
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));
CREATE POLICY membership_plans_insert_own_gym ON public.membership_plans
    FOR INSERT TO authenticated WITH CHECK (public.gympulse_user_has_gym(gym_id));
CREATE POLICY membership_plans_update_own_gym ON public.membership_plans
    FOR UPDATE TO authenticated USING (public.gympulse_user_has_gym(gym_id))
    WITH CHECK (public.gympulse_user_has_gym(gym_id));
CREATE POLICY membership_plans_delete_own_gym ON public.membership_plans
    FOR DELETE TO authenticated USING (public.gympulse_user_has_gym(gym_id));

CREATE POLICY member_memberships_select_own_gym ON public.member_memberships
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));
CREATE POLICY member_memberships_insert_own_gym ON public.member_memberships
    FOR INSERT TO authenticated WITH CHECK (public.gympulse_user_has_gym(gym_id));
CREATE POLICY member_memberships_update_own_gym ON public.member_memberships
    FOR UPDATE TO authenticated USING (public.gympulse_user_has_gym(gym_id))
    WITH CHECK (public.gympulse_user_has_gym(gym_id));
CREATE POLICY member_memberships_delete_own_gym ON public.member_memberships
    FOR DELETE TO authenticated USING (public.gympulse_user_has_gym(gym_id));

CREATE POLICY payments_select_own_gym ON public.payments
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));
CREATE POLICY payments_insert_own_gym ON public.payments
    FOR INSERT TO authenticated WITH CHECK (public.gympulse_user_has_gym(gym_id));
CREATE POLICY payments_update_own_gym ON public.payments
    FOR UPDATE TO authenticated USING (public.gympulse_user_has_gym(gym_id))
    WITH CHECK (public.gympulse_user_has_gym(gym_id));
CREATE POLICY payments_delete_own_gym ON public.payments
    FOR DELETE TO authenticated USING (public.gympulse_user_has_gym(gym_id));

DROP FUNCTION IF EXISTS public.gympulse_assign_member_plan(uuid, uuid, date);
CREATE OR REPLACE FUNCTION public.gympulse_assign_member_plan(
    p_member_id uuid,
    p_plan_id uuid,
    p_start_date date,
    p_gym_id uuid
)
RETURNS SETOF public.member_memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    IF p_start_date IS NULL OR p_gym_id IS NULL THEN
        RAISE EXCEPTION 'Membership start date and gym are required.' USING ERRCODE = '22004';
    END IF;
    SELECT gym_id INTO v_gym_id FROM public.members
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
        gym_id, member_id, plan_id, plan_name, duration_days, price, start_date, end_date
    ) VALUES (
        p_gym_id, p_member_id, v_plan.id, v_plan.name, v_plan.duration_days, v_plan.price, p_start_date, v_end_date
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

REVOKE ALL ON FUNCTION public.gympulse_assign_member_plan(uuid, uuid, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_assign_member_plan(uuid, uuid, date, uuid) TO service_role;
