-- 014: Optional member photos, consent first, in the private "member-photos" Storage bucket.
-- Photos stay inside the app: only the backend (service role) reads or writes them, and viewers
-- get 1-hour signed URLs for members of their own gym. Existing members start with no photo
-- and no photo consent; nobody is assumed to have agreed.

-- ---------- members: photo columns ----------
ALTER TABLE public.members
    ADD COLUMN IF NOT EXISTS photo_path text,
    ADD COLUMN IF NOT EXISTS photo_status text NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS photo_updated_at timestamptz,
    ADD COLUMN IF NOT EXISTS photo_consent boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS photo_consent_at timestamptz,
    -- The poster-page phone (member_devices.id) that sent a pending photo, so rejecting that
    -- phone's request also removes its photo. Plain id, no foreign key: rejected requests are deleted.
    ADD COLUMN IF NOT EXISTS photo_device_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_photo_status_valid') THEN
        ALTER TABLE public.members
            ADD CONSTRAINT members_photo_status_valid CHECK (photo_status IN ('none', 'pending', 'approved')),
            ADD CONSTRAINT members_photo_path_matches_status CHECK ((photo_path IS NULL) = (photo_status = 'none')),
            -- Always <this member's gym>/<this member>/<random>.jpg|.webp
            ADD CONSTRAINT members_photo_path_own_gym CHECK (photo_path IS NULL OR (
                photo_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9_-]{22,64}\.(jpg|webp)$'
                AND split_part(photo_path, '/', 1) = gym_id::text
                AND split_part(photo_path, '/', 2) = id::text)),
            ADD CONSTRAINT members_photo_needs_consent CHECK (photo_path IS NULL OR photo_consent),
            ADD CONSTRAINT members_photo_has_time CHECK (photo_path IS NULL OR photo_updated_at IS NOT NULL),
            ADD CONSTRAINT members_photo_consent_has_time CHECK (photo_consent = (photo_consent_at IS NOT NULL)),
            ADD CONSTRAINT members_photo_device_only_pending CHECK (photo_device_id IS NULL OR photo_status = 'pending'),
            ADD CONSTRAINT members_archived_has_no_photo CHECK (archived_at IS NULL OR photo_path IS NULL);
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS members_gym_photo_pending_idx
    ON public.members (gym_id, photo_updated_at DESC) WHERE photo_status = 'pending';

-- ---------- Consent history: 'photo' alongside 'whatsapp' (still append-only) ----------
ALTER TABLE public.member_consent_events
    DROP CONSTRAINT IF EXISTS member_consent_events_channel_valid,
    DROP CONSTRAINT IF EXISTS member_consent_events_source_valid;
ALTER TABLE public.member_consent_events
    ADD CONSTRAINT member_consent_events_channel_valid CHECK (channel IN ('whatsapp', 'photo')),
    ADD CONSTRAINT member_consent_events_source_valid CHECK (
        (channel = 'whatsapp' AND source IN ('staff_form', 'csv_import', 'member_reply_stop'))
        OR (channel = 'photo' AND source IN ('desk', 'poster_page')));

-- ---------- Photo columns are written only by the backend ----------
-- Logged-in browser roles keep their existing member grants but can never touch a photo column.
CREATE OR REPLACE FUNCTION public.gympulse_guard_member_photo()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_user IN ('anon', 'authenticated') AND (
        (TG_OP = 'INSERT' AND (NEW.photo_path IS NOT NULL OR NEW.photo_status <> 'none' OR NEW.photo_consent
            OR NEW.photo_device_id IS NOT NULL))
        OR (TG_OP = 'UPDATE' AND (
            NEW.photo_path IS DISTINCT FROM OLD.photo_path
            OR NEW.photo_status IS DISTINCT FROM OLD.photo_status
            OR NEW.photo_updated_at IS DISTINCT FROM OLD.photo_updated_at
            OR NEW.photo_device_id IS DISTINCT FROM OLD.photo_device_id
            OR NEW.photo_consent IS DISTINCT FROM OLD.photo_consent
            OR NEW.photo_consent_at IS DISTINCT FROM OLD.photo_consent_at))
    ) THEN
        RAISE EXCEPTION 'Member photos are managed by the GymPulse server.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS members_guard_photo ON public.members;
CREATE TRIGGER members_guard_photo
    BEFORE INSERT OR UPDATE ON public.members
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_guard_member_photo();

-- ---------- Photo consent: every change writes exactly one history event ----------
-- A change is refused unless gympulse_set_member_photo_consent supplied a source, so the
-- member's consent and its history cannot disagree.
CREATE OR REPLACE FUNCTION public.gympulse_track_member_photo_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_source text := nullif(current_setting('gympulse.photo_consent_source', true), '');
    v_recorded_by uuid := nullif(current_setting('gympulse.photo_consent_recorded_by', true), '')::uuid;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.photo_consent OR NEW.photo_path IS NOT NULL THEN
            RAISE EXCEPTION 'New members start without a photo or photo consent.' USING ERRCODE = '23514';
        END IF;
        NEW.photo_consent_at := NULL;
        RETURN NEW;
    END IF;

    IF NEW.photo_consent IS NOT DISTINCT FROM OLD.photo_consent THEN
        -- The consent time only changes together with the consent itself.
        NEW.photo_consent_at := OLD.photo_consent_at;
        RETURN NEW;
    END IF;

    IF v_source IS NULL THEN
        RAISE EXCEPTION 'Change photo consent with gympulse_set_member_photo_consent.' USING ERRCODE = '42501';
    END IF;

    NEW.photo_consent_at := CASE WHEN NEW.photo_consent THEN now() ELSE NULL END;
    INSERT INTO public.member_consent_events (gym_id, member_id, channel, action, source, recorded_by, created_at)
    VALUES (NEW.gym_id, NEW.id, 'photo', CASE WHEN NEW.photo_consent THEN 'granted' ELSE 'withdrawn' END,
        v_source, v_recorded_by, now());
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_track_member_photo_consent() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS members_track_photo_consent ON public.members;
CREATE TRIGGER members_track_photo_consent
    BEFORE INSERT OR UPDATE ON public.members
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_track_member_photo_consent();

-- Grants or withdraws photo consent for one member of one gym. Withdrawing also clears the
-- photo columns in the same statement; the server deletes the Storage file before calling this.
-- Repeating the current choice changes nothing and adds no history.
CREATE OR REPLACE FUNCTION public.gympulse_set_member_photo_consent(
    p_gym_id uuid,
    p_member_id uuid,
    p_consent boolean,
    p_source text,
    p_recorded_by uuid
)
RETURNS SETOF public.members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_member public.members%ROWTYPE;
BEGIN
    IF p_gym_id IS NULL OR p_member_id IS NULL OR p_consent IS NULL THEN
        RAISE EXCEPTION 'Gym, member and consent choice are required.' USING ERRCODE = '22004';
    END IF;
    IF p_source IS NULL OR p_source NOT IN ('desk', 'poster_page') THEN
        RAISE EXCEPTION 'Unknown consent source.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_member FROM public.members
    WHERE id = p_member_id AND gym_id = p_gym_id AND archived_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member not found.' USING ERRCODE = 'P0002';
    END IF;

    IF v_member.photo_consent = p_consent THEN
        RETURN NEXT v_member;
        RETURN;
    END IF;

    PERFORM set_config('gympulse.photo_consent_source', p_source, true);
    PERFORM set_config('gympulse.photo_consent_recorded_by', coalesce(p_recorded_by::text, ''), true);
    UPDATE public.members
    SET photo_consent = p_consent,
        photo_path = CASE WHEN p_consent THEN photo_path ELSE NULL END,
        photo_status = CASE WHEN p_consent THEN photo_status ELSE 'none' END,
        photo_device_id = CASE WHEN p_consent THEN photo_device_id ELSE NULL END,
        photo_updated_at = CASE WHEN p_consent THEN photo_updated_at ELSE now() END,
        updated_at = now()
    WHERE id = p_member_id AND gym_id = p_gym_id
    RETURNING * INTO v_member;
    -- Clear the markers so no later statement in this transaction can reuse them.
    PERFORM set_config('gympulse.photo_consent_source', '', true);
    PERFORM set_config('gympulse.photo_consent_recorded_by', '', true);

    RETURN NEXT v_member;
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_set_member_photo_consent(uuid, uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_set_member_photo_consent(uuid, uuid, boolean, text, uuid) TO service_role;

-- ---------- Private Storage bucket (skipped where Supabase Storage does not exist, e.g. tests) ----------
DO $$
BEGIN
    IF to_regclass('storage.buckets') IS NULL THEN
        RAISE NOTICE 'Supabase Storage not found: create the private "member-photos" bucket by hand.';
        RETURN;
    END IF;
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('member-photos', 'member-photos', false, 307200, ARRAY['image/jpeg', 'image/webp'])
    ON CONFLICT (id) DO UPDATE
        SET public = false,
            file_size_limit = EXCLUDED.file_size_limit,
            allowed_mime_types = EXCLUDED.allowed_mime_types;
END;
$$;

-- No browser role may list, read, upload or delete in this bucket, even if a broad policy is
-- added later: a RESTRICTIVE policy must pass in addition to every permissive one.
-- The backend's service role bypasses RLS; viewers only ever get 1-hour signed URLs from it.
DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RETURN;
    END IF;
    DROP POLICY IF EXISTS member_photos_no_client_access ON storage.objects;
    CREATE POLICY member_photos_no_client_access ON storage.objects
        AS RESTRICTIVE FOR ALL TO anon, authenticated
        USING (bucket_id <> 'member-photos')
        WITH CHECK (bucket_id <> 'member-photos');
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Could not add the storage.objects policy; the bucket is still private (no policy grants access).';
END;
$$;
