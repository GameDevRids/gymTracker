-- 013: One check-in method per gym (member QR card or entrance poster), the expired-member
-- policy, entrance poster tokens and member phones linked to the poster.
-- No counter/kiosk mode or per-method switches existed before this, so nothing is dropped.

-- ---------- Gym check-in settings ----------
ALTER TABLE public.gyms
    ADD COLUMN IF NOT EXISTS checkin_method text,
    ADD COLUMN IF NOT EXISTS expired_checkin_policy text NOT NULL DEFAULT 'warn',
    ADD COLUMN IF NOT EXISTS expiry_grace_days integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS entrance_token text,
    ADD COLUMN IF NOT EXISTS entrance_require_location boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS latitude double precision,
    ADD COLUMN IF NOT EXISTS longitude double precision,
    ADD COLUMN IF NOT EXISTS location_radius_m integer NOT NULL DEFAULT 150;

-- Gyms already scanning member QR cards keep that method; all others start on the poster.
UPDATE public.gyms g
SET checkin_method = CASE
    WHEN EXISTS (SELECT 1 FROM public.attendance a WHERE a.gym_id = g.id AND a.method = 'qr') THEN 'member_qr'
    ELSE 'entrance_poster' END
WHERE checkin_method IS NULL;
-- Same 43-character random generator as member QR tokens (migration 012).
UPDATE public.gyms SET entrance_token = public.gympulse_new_qr_token() WHERE entrance_token IS NULL;

ALTER TABLE public.gyms
    ALTER COLUMN checkin_method SET DEFAULT 'entrance_poster',
    ALTER COLUMN checkin_method SET NOT NULL,
    ALTER COLUMN entrance_token SET DEFAULT public.gympulse_new_qr_token(),
    ALTER COLUMN entrance_token SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gyms_checkin_method_valid') THEN
        ALTER TABLE public.gyms
            ADD CONSTRAINT gyms_checkin_method_valid CHECK (checkin_method IN ('member_qr', 'entrance_poster')),
            ADD CONSTRAINT gyms_expired_checkin_policy_valid CHECK (expired_checkin_policy IN ('warn', 'block')),
            ADD CONSTRAINT gyms_expiry_grace_days_range CHECK (expiry_grace_days BETWEEN 0 AND 60),
            ADD CONSTRAINT gyms_entrance_token_format CHECK (entrance_token ~ '^[A-Za-z0-9_-]{22,128}$'),
            ADD CONSTRAINT gyms_location_valid CHECK (
                (latitude IS NULL) = (longitude IS NULL)
                AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))),
            ADD CONSTRAINT gyms_location_radius_range CHECK (location_radius_m BETWEEN 25 AND 2000),
            ADD CONSTRAINT gyms_location_check_needs_point CHECK (NOT entrance_require_location OR latitude IS NOT NULL);
    END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS gyms_entrance_token_key ON public.gyms (entrance_token);
-- gyms has no UPDATE grant for authenticated (migration 007): only the backend changes these,
-- and the API allows it for the owner role only.

-- ---------- Phone lookups (poster linking, manual "last 4 digits" search) ----------
ALTER TABLE public.members
    ADD COLUMN IF NOT EXISTS phone_last10 text
        GENERATED ALWAYS AS (right(regexp_replace(phone, '\D', '', 'g'), 10)) STORED,
    ADD COLUMN IF NOT EXISTS phone_last4 text
        GENERATED ALWAYS AS (right(regexp_replace(phone, '\D', '', 'g'), 4)) STORED;
CREATE INDEX IF NOT EXISTS members_gym_phone_last10_idx ON public.members (gym_id, phone_last10);
CREATE INDEX IF NOT EXISTS members_gym_phone_last4_idx ON public.members (gym_id, phone_last4);

-- ---------- Member phones linked to the entrance poster ----------
-- One row per (member, phone). A family phone has one secret and a row for each member on it.
CREATE TABLE IF NOT EXISTS public.member_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id uuid NOT NULL,
    member_id uuid NOT NULL,
    -- SHA-256 (hex) of the 256-bit random secret in the phone's HttpOnly cookie. Never the secret.
    device_secret_hash text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    device_label text,                       -- e.g. "Android · Chrome", for the staff list
    created_at timestamptz NOT NULL DEFAULT now(),
    approved_at timestamptz,
    approved_by uuid,
    revoked_at timestamptz,
    revoked_by uuid,
    last_used_at timestamptz,
    CONSTRAINT member_devices_gym_id_fkey
        FOREIGN KEY (gym_id) REFERENCES public.gyms (id) ON DELETE CASCADE,
    CONSTRAINT member_devices_gym_member_fkey
        FOREIGN KEY (gym_id, member_id) REFERENCES public.members (gym_id, id) ON DELETE CASCADE,
    CONSTRAINT member_devices_gym_id_id_key UNIQUE (gym_id, id),
    CONSTRAINT member_devices_one_per_member_phone UNIQUE (gym_id, member_id, device_secret_hash),
    CONSTRAINT member_devices_status_valid CHECK (status IN ('pending', 'approved', 'revoked')),
    CONSTRAINT member_devices_hash_format CHECK (device_secret_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT member_devices_label_length CHECK (device_label IS NULL OR char_length(device_label) <= 60),
    CONSTRAINT member_devices_approved_has_time CHECK (status <> 'approved' OR approved_at IS NOT NULL),
    CONSTRAINT member_devices_revoked_has_time CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS member_devices_gym_hash_idx ON public.member_devices (gym_id, device_secret_hash);
CREATE INDEX IF NOT EXISTS member_devices_gym_pending_idx
    ON public.member_devices (gym_id, created_at DESC) WHERE status = 'pending';

ALTER TABLE public.member_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_devices FROM PUBLIC, anon, authenticated;
-- Gym logins can read their own gym's linked phones, but never the secret hash.
GRANT SELECT (id, gym_id, member_id, status, device_label, created_at, approved_at, approved_by,
    revoked_at, revoked_by, last_used_at) ON public.member_devices TO authenticated;
GRANT ALL ON public.member_devices TO service_role;
DROP POLICY IF EXISTS member_devices_select_own_gym ON public.member_devices;
CREATE POLICY member_devices_select_own_gym ON public.member_devices
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));

-- ---------- Attendance: new method names and statuses; past rows are kept ----------
ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS attendance_method_valid;
UPDATE public.attendance SET method = 'member_qr' WHERE method = 'qr';
ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS attendance_membership_status_valid;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS member_device_id uuid;
-- The two checks were dropped above, so they are always added back; the others only once.
ALTER TABLE public.attendance
    ADD CONSTRAINT attendance_method_valid
        CHECK (method IN ('member_qr', 'entrance_poster', 'manual')),
    -- grace = expired but inside the gym's grace days; upcoming = plan starts later.
    ADD CONSTRAINT attendance_membership_status_valid
        CHECK (membership_status_at_check_in IN ('active', 'grace', 'upcoming', 'expired', 'none'));
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_member_device_fkey') THEN
        -- Which linked phone made a poster check-in; other methods have none.
        ALTER TABLE public.attendance
            ADD CONSTRAINT attendance_member_device_fkey
                FOREIGN KEY (gym_id, member_device_id) REFERENCES public.member_devices (gym_id, id) ON DELETE RESTRICT,
            ADD CONSTRAINT attendance_device_matches_method
                CHECK ((method = 'entrance_poster') = (member_device_id IS NOT NULL));
    END IF;
END;
$$;
