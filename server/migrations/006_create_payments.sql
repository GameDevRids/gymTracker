CREATE TABLE IF NOT EXISTS public.payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id uuid,
    member_id uuid NOT NULL,
    membership_id uuid,
    amount numeric(12, 2) NOT NULL,
    method text NOT NULL,
    paid_on date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payments_member_id_fkey
        FOREIGN KEY (member_id) REFERENCES public.members (id) ON DELETE RESTRICT,
    CONSTRAINT payments_membership_id_fkey
        FOREIGN KEY (membership_id) REFERENCES public.member_memberships (id) ON DELETE RESTRICT,
    CONSTRAINT payments_amount_positive CHECK (amount > 0),
    CONSTRAINT payments_method_valid CHECK (method IN ('cash', 'upi', 'card', 'other'))
);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payments FROM anon, authenticated;
GRANT ALL ON public.payments TO service_role;

CREATE INDEX IF NOT EXISTS payments_member_paid_on_idx
    ON public.payments (member_id, paid_on DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_membership_idx
    ON public.payments (membership_id);
CREATE INDEX IF NOT EXISTS payments_gym_paid_on_idx
    ON public.payments (gym_id, paid_on DESC);
