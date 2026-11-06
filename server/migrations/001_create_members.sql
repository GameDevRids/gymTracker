CREATE TABLE IF NOT EXISTS public.members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id uuid,
    member_code text NOT NULL,
    full_name text NOT NULL,
    phone text NOT NULL,
    email text,
    gender text,
    date_of_birth date,
    membership_start_date date NOT NULL,
    membership_end_date date NOT NULL,
    status text NOT NULL DEFAULT 'active',
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT members_gym_id_member_code_key UNIQUE (gym_id, member_code),
    CONSTRAINT members_member_code_nonempty CHECK (btrim(member_code) <> ''),
    CONSTRAINT members_full_name_nonempty CHECK (btrim(full_name) <> ''),
    CONSTRAINT members_phone_nonempty CHECK (btrim(phone) <> ''),
    CONSTRAINT members_membership_dates_valid CHECK (membership_end_date >= membership_start_date),
    CONSTRAINT members_status_valid CHECK (status IN ('active', 'suspended'))
);

CREATE UNIQUE INDEX IF NOT EXISTS members_unassigned_member_code_key
    ON public.members (member_code)
    WHERE gym_id IS NULL;

CREATE INDEX IF NOT EXISTS members_gym_id_status_idx
    ON public.members (gym_id, status);

CREATE INDEX IF NOT EXISTS members_gym_id_membership_end_date_idx
    ON public.members (gym_id, membership_end_date);

CREATE OR REPLACE FUNCTION public.gympulse_set_members_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS members_set_updated_at ON public.members;
CREATE TRIGGER members_set_updated_at
    BEFORE UPDATE ON public.members
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_set_members_updated_at();
