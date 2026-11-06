CREATE TABLE IF NOT EXISTS public.membership_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id uuid,
    name text NOT NULL,
    description text,
    duration_days integer NOT NULL,
    price numeric(12, 2) NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT membership_plans_name_nonempty CHECK (btrim(name) <> ''),
    CONSTRAINT membership_plans_duration_positive CHECK (duration_days > 0),
    CONSTRAINT membership_plans_price_nonnegative CHECK (price >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS membership_plans_gym_name_key
    ON public.membership_plans (gym_id, lower(btrim(name)))
    WHERE gym_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS membership_plans_unassigned_name_key
    ON public.membership_plans (lower(btrim(name)))
    WHERE gym_id IS NULL;

CREATE INDEX IF NOT EXISTS membership_plans_gym_active_idx
    ON public.membership_plans (gym_id, is_active);

CREATE INDEX IF NOT EXISTS membership_plans_gym_name_idx
    ON public.membership_plans (gym_id, name);

CREATE OR REPLACE FUNCTION public.gympulse_set_membership_plans_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS membership_plans_set_updated_at ON public.membership_plans;
CREATE TRIGGER membership_plans_set_updated_at
    BEFORE UPDATE ON public.membership_plans
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_set_membership_plans_updated_at();
