ALTER TABLE public.members
    ADD COLUMN IF NOT EXISTS archived_at timestamptz;
