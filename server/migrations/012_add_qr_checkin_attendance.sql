-- 012: QR check-in tokens on members, and attendance stored in the database.

-- A 43-character URL-safe random token: two v4 UUIDs (244 random bits from Postgres's
-- cryptographic generator), base64url-encoded. It holds nothing about the member.
CREATE OR REPLACE FUNCTION public.gympulse_new_qr_token()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
    SELECT rtrim(translate(encode(decode(
        replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'),
        'base64'), '+/', '-_'), '=');
$$;

ALTER TABLE public.members ADD COLUMN IF NOT EXISTS qr_token text;
UPDATE public.members SET qr_token = public.gympulse_new_qr_token() WHERE qr_token IS NULL;
ALTER TABLE public.members
    ALTER COLUMN qr_token SET DEFAULT public.gympulse_new_qr_token(),
    ALTER COLUMN qr_token SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_qr_token_format') THEN
        ALTER TABLE public.members ADD CONSTRAINT members_qr_token_format
            CHECK (qr_token ~ '^[A-Za-z0-9_-]{22,128}$');
    END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS members_qr_token_key ON public.members (qr_token);

CREATE TABLE IF NOT EXISTS public.attendance (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id uuid NOT NULL,
    member_id uuid NOT NULL,
    checked_in_at timestamptz NOT NULL DEFAULT now(),
    -- The gym's calendar day, always derived from checked_in_at so the two can never disagree.
    check_in_date date GENERATED ALWAYS AS ((checked_in_at AT TIME ZONE 'Asia/Kolkata')::date) STORED,
    method text NOT NULL,
    membership_status_at_check_in text NOT NULL,
    -- Plain id, not a foreign key, so the record survives if that login is removed.
    recorded_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT attendance_gym_id_fkey
        FOREIGN KEY (gym_id) REFERENCES public.gyms (id) ON DELETE CASCADE,
    CONSTRAINT attendance_gym_member_fkey
        FOREIGN KEY (gym_id, member_id) REFERENCES public.members (gym_id, id) ON DELETE RESTRICT,
    CONSTRAINT attendance_method_valid CHECK (method IN ('qr', 'manual')),
    CONSTRAINT attendance_membership_status_valid
        CHECK (membership_status_at_check_in IN ('active', 'expired', 'none'))
);

-- One check-in per member per IST day; a second scan hits this and reports "already checked in".
CREATE UNIQUE INDEX IF NOT EXISTS attendance_one_per_member_per_day
    ON public.attendance (gym_id, member_id, check_in_date);
-- Today's list and date filters.
CREATE INDEX IF NOT EXISTS attendance_gym_day_idx
    ON public.attendance (gym_id, check_in_date DESC, checked_in_at DESC);
-- A member's history and last visit.
CREATE INDEX IF NOT EXISTS attendance_gym_member_idx
    ON public.attendance (gym_id, member_id, checked_in_at DESC);

ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.attendance TO authenticated;
GRANT ALL ON public.attendance TO service_role;
DROP POLICY IF EXISTS attendance_select_own_gym ON public.attendance;
CREATE POLICY attendance_select_own_gym ON public.attendance
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));
