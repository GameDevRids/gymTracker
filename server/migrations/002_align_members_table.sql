ALTER TABLE public.members
    ADD COLUMN IF NOT EXISTS gym_id uuid,
    ADD COLUMN IF NOT EXISTS member_code text,
    ADD COLUMN IF NOT EXISTS email text,
    ADD COLUMN IF NOT EXISTS gender text,
    ADD COLUMN IF NOT EXISTS date_of_birth date,
    ADD COLUMN IF NOT EXISTS membership_start_date date,
    ADD COLUMN IF NOT EXISTS membership_end_date date,
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS notes text,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.members
SET member_code = 'GP-' || upper(id::text)
WHERE member_code IS NULL;

ALTER TABLE public.members
    ALTER COLUMN member_code SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.members
        WHERE membership_start_date IS NULL OR membership_end_date IS NULL
    ) THEN
        ALTER TABLE public.members
            ALTER COLUMN membership_start_date SET NOT NULL,
            ALTER COLUMN membership_end_date SET NOT NULL;
    ELSE
        RAISE NOTICE 'Membership dates remain nullable until existing member dates are supplied.';
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_gym_id_member_code_key') THEN
        ALTER TABLE public.members
            ADD CONSTRAINT members_gym_id_member_code_key UNIQUE (gym_id, member_code);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_member_code_nonempty') THEN
        ALTER TABLE public.members
            ADD CONSTRAINT members_member_code_nonempty CHECK (btrim(member_code) <> '');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_full_name_nonempty') THEN
        ALTER TABLE public.members
            ADD CONSTRAINT members_full_name_nonempty CHECK (btrim(full_name) <> '');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_phone_nonempty') THEN
        ALTER TABLE public.members
            ADD CONSTRAINT members_phone_nonempty CHECK (btrim(phone) <> '');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_membership_dates_valid') THEN
        ALTER TABLE public.members
            ADD CONSTRAINT members_membership_dates_valid
            CHECK (membership_start_date IS NULL OR membership_end_date IS NULL OR membership_end_date >= membership_start_date);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_status_valid') THEN
        ALTER TABLE public.members
            ADD CONSTRAINT members_status_valid CHECK (status IN ('active', 'suspended'));
    END IF;
END;
$$;

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
