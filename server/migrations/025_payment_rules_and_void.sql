-- 025: payments can't go over what is due, one payment per request, and voiding (owner only).
-- Review before running in the Supabase SQL Editor. Safe to run more than once. Changes no existing payment.
--
-- * Balance due on a membership = its fee (total_fees: the price after any discount) minus its
--   plan payments that are not voided. Hold fees are not plan payments.
-- * Every new plan payment (Record payment, Add member, Renew, import) is checked by a trigger in
--   the same transaction that saves it. The membership row is locked first, so two saves at the
--   same moment can't both pass. Nothing due: "Already fully paid". Too much: "Only ₹X is due".
-- * Record payment goes through gympulse_record_payment with a request key: a double tap or a
--   retry returns the first payment instead of saving a second one.
-- * Voiding keeps the payment and its receipt number; it is marked voided with who, when and why,
--   and is left out of balances and money collected. A voided payment can't be changed or un-voided.

-- ---------- New columns ----------
ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'paid',
    ADD COLUMN IF NOT EXISTS voided_at timestamptz,
    ADD COLUMN IF NOT EXISTS voided_by uuid,
    ADD COLUMN IF NOT EXISTS void_reason text,
    ADD COLUMN IF NOT EXISTS idempotency_key uuid,
    ADD COLUMN IF NOT EXISTS recorded_by uuid;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_status_valid') THEN
        ALTER TABLE public.payments ADD CONSTRAINT payments_status_valid CHECK (status IN ('paid', 'voided'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_void_complete') THEN
        ALTER TABLE public.payments ADD CONSTRAINT payments_void_complete CHECK (
            (status = 'voided') = (voided_at IS NOT NULL)
            AND (status <> 'voided' OR char_length(btrim(coalesce(void_reason, ''))) BETWEEN 3 AND 300));
    END IF;
END;
$$;

-- One payment per request key per gym (backs up the check in gympulse_record_payment).
CREATE UNIQUE INDEX IF NOT EXISTS payments_gym_idempotency_key
    ON public.payments (gym_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Plan payments of one membership, added up on every save.
CREATE INDEX IF NOT EXISTS payments_membership_plan_idx
    ON public.payments (gym_id, membership_id) WHERE kind = 'plan' AND status = 'paid';

-- ---------- Balance due on one membership ----------
CREATE OR REPLACE FUNCTION public.gympulse_membership_balance(p_gym_id uuid, p_membership_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT coalesce(mm.total_fees, mm.price, 0) - coalesce((
        SELECT sum(p.amount) FROM public.payments p
        WHERE p.gym_id = mm.gym_id AND p.membership_id = mm.id AND p.kind = 'plan' AND p.status = 'paid'), 0)
    FROM public.member_memberships mm
    WHERE mm.id = p_membership_id AND mm.gym_id = p_gym_id;
$$;
REVOKE ALL ON FUNCTION public.gympulse_membership_balance(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_membership_balance(uuid, uuid) TO service_role;

-- ---------- Every new plan payment stays within the balance due ----------
CREATE OR REPLACE FUNCTION public.gympulse_payment_within_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_mm public.member_memberships%ROWTYPE;
    v_due numeric;
BEGIN
    IF NEW.status IS DISTINCT FROM 'paid' THEN
        RAISE EXCEPTION 'A new payment cannot be saved as voided.' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind IS DISTINCT FROM 'plan' THEN
        RETURN NEW;  -- a hold fee is a set amount, checked when the hold starts
    END IF;
    IF NEW.membership_id IS NULL THEN
        RAISE EXCEPTION 'Choose the plan this payment is for.' USING ERRCODE = 'P0001', DETAIL = 'membership_required';
    END IF;
    -- Locked until this transaction ends: a second save for the same plan waits here, then sees this one.
    SELECT * INTO v_mm FROM public.member_memberships
    WHERE id = NEW.membership_id AND gym_id = NEW.gym_id AND member_id = NEW.member_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Membership not found for this member.' USING ERRCODE = 'P0002';
    END IF;
    IF v_mm.status = 'cancelled' THEN
        RAISE EXCEPTION 'This plan was cancelled, so nothing is due on it.' USING ERRCODE = 'P0001', DETAIL = 'membership_cancelled';
    END IF;
    v_due := public.gympulse_membership_balance(NEW.gym_id, NEW.membership_id);
    IF v_due <= 0 THEN
        RAISE EXCEPTION 'Already fully paid.' USING ERRCODE = 'P0001', DETAIL = 'fully_paid', HINT = '0';
    END IF;
    IF NEW.amount > v_due THEN
        RAISE EXCEPTION 'Only ₹% is due.', CASE WHEN v_due = trunc(v_due) THEN trunc(v_due)::text ELSE to_char(v_due, 'FM999999990.00') END
            USING ERRCODE = 'P0001', DETAIL = 'over_balance', HINT = v_due::text;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_payment_within_balance() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS payments_within_balance ON public.payments;
CREATE TRIGGER payments_within_balance
    BEFORE INSERT ON public.payments
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_payment_within_balance();

-- ---------- A voided payment is final ----------
CREATE OR REPLACE FUNCTION public.gympulse_payment_void_is_final()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF OLD.status = 'voided' AND (
        NEW.status IS DISTINCT FROM OLD.status OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.member_id IS DISTINCT FROM OLD.member_id OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
        OR NEW.method IS DISTINCT FROM OLD.method OR NEW.paid_on IS DISTINCT FROM OLD.paid_on
        OR NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.voided_by IS DISTINCT FROM OLD.voided_by
        OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
        RAISE EXCEPTION 'A voided payment cannot be changed.' USING ERRCODE = 'P0001', DETAIL = 'already_voided';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_payment_void_is_final() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS payments_void_is_final ON public.payments;
CREATE TRIGGER payments_void_is_final
    BEFORE UPDATE ON public.payments
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_payment_void_is_final();

-- ---------- What the app is told about a payment ----------
CREATE OR REPLACE FUNCTION public.gympulse_payment_result(p_gym_id uuid, p_payment_id uuid, p_replayed boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'replayed', p_replayed,
        'payment', to_jsonb(p.*) - 'idempotency_key',
        'balance_due', CASE WHEN p.kind = 'plan' AND p.membership_id IS NOT NULL
            THEN greatest(public.gympulse_membership_balance(p.gym_id, p.membership_id), 0) END)
    FROM public.payments p
    WHERE p.id = p_payment_id AND p.gym_id = p_gym_id;
$$;
REVOKE ALL ON FUNCTION public.gympulse_payment_result(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

-- ---------- Record payment ----------
CREATE OR REPLACE FUNCTION public.gympulse_record_payment(
    p_gym_id uuid,
    p_member_id uuid,
    p_membership_id uuid,
    p_amount numeric,
    p_method text,
    p_paid_on date,
    p_note text,
    p_upi_reference text,
    p_idempotency_key uuid,
    p_recorded_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_payment public.payments%ROWTYPE;
BEGIN
    IF p_gym_id IS NULL OR p_member_id IS NULL OR p_idempotency_key IS NULL OR p_amount IS NULL OR p_paid_on IS NULL THEN
        RAISE EXCEPTION 'Gym, member, amount, date and request key are required.' USING ERRCODE = '22004';
    END IF;
    -- One request at a time per member, so a retry with the same key waits for the first and finds it.
    PERFORM 1 FROM public.members
    WHERE id = p_member_id AND gym_id = p_gym_id AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member not found.' USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_payment FROM public.payments
    WHERE gym_id = p_gym_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_payment.member_id <> p_member_id THEN
            RAISE EXCEPTION 'This request key belongs to another member.' USING ERRCODE = '22023';
        END IF;
        RETURN public.gympulse_payment_result(p_gym_id, v_payment.id, true);
    END IF;

    -- The balance check runs in payments_within_balance, in this same transaction.
    INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method, paid_on, note, upi_reference,
        idempotency_key, recorded_by)
    VALUES (p_gym_id, p_member_id, p_membership_id, round(p_amount, 2), p_method, p_paid_on, nullif(btrim(p_note), ''),
        CASE WHEN p_method = 'upi' THEN nullif(btrim(p_upi_reference), '') END, p_idempotency_key, p_recorded_by)
    RETURNING * INTO v_payment;
    RETURN public.gympulse_payment_result(p_gym_id, v_payment.id, false);
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_record_payment(uuid, uuid, uuid, numeric, text, date, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_record_payment(uuid, uuid, uuid, numeric, text, date, text, text, uuid, uuid) TO service_role;

-- ---------- Void a payment (the server allows owners only) ----------
CREATE OR REPLACE FUNCTION public.gympulse_void_payment(p_gym_id uuid, p_payment_id uuid, p_reason text, p_by uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_payment public.payments%ROWTYPE;
BEGIN
    IF p_gym_id IS NULL OR p_payment_id IS NULL OR p_by IS NULL THEN
        RAISE EXCEPTION 'Gym, payment and owner are required.' USING ERRCODE = '22004';
    END IF;
    IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 300 THEN
        RAISE EXCEPTION 'Give a reason for voiding (3 to 300 characters).' USING ERRCODE = '22023', DETAIL = 'reason_required';
    END IF;
    SELECT * INTO v_payment FROM public.payments
    WHERE id = p_payment_id AND gym_id = p_gym_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment not found.' USING ERRCODE = 'P0002';
    END IF;
    IF v_payment.status = 'voided' THEN
        RAISE EXCEPTION 'This payment is already voided.' USING ERRCODE = 'P0001', DETAIL = 'already_voided';
    END IF;
    IF v_payment.refunded_at IS NOT NULL THEN
        RAISE EXCEPTION 'This hold fee was already given back when the hold was cancelled.' USING ERRCODE = 'P0001', DETAIL = 'refunded';
    END IF;
    UPDATE public.payments
    SET status = 'voided', voided_at = now(), voided_by = p_by, void_reason = btrim(p_reason)
    WHERE id = p_payment_id AND gym_id = p_gym_id;
    RETURN public.gympulse_payment_result(p_gym_id, p_payment_id, false);
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_void_payment(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_void_payment(uuid, uuid, text, uuid) TO service_role;

-- ---------- Voided payments are left out of balances and money collected ----------
-- (Same as migration 021, with "AND status = 'paid'" added wherever payments are added up.)
CREATE OR REPLACE VIEW public.member_balances
WITH (security_invoker = true) AS
SELECT
    m.gym_id,
    m.id AS member_id,
    coalesce(b.billed, 0)::numeric(12, 2) AS billed,
    coalesce(p.paid, 0)::numeric(12, 2) AS paid,
    greatest(coalesce(b.billed, 0) - coalesce(p.paid, 0), 0)::numeric(12, 2) AS outstanding
FROM public.members m
LEFT JOIN (
    SELECT gym_id, member_id, sum(total_fees) AS billed
    FROM public.member_memberships
    WHERE status <> 'cancelled'
    GROUP BY gym_id, member_id
) b ON b.gym_id = m.gym_id AND b.member_id = m.id
LEFT JOIN (
    SELECT gym_id, member_id, sum(amount) AS paid
    FROM public.payments
    WHERE kind = 'plan' AND status = 'paid'
    GROUP BY gym_id, member_id
) p ON p.gym_id = m.gym_id AND p.member_id = m.id
WHERE m.archived_at IS NULL;
REVOKE ALL ON public.member_balances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.member_balances TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.gympulse_renewal_result(p_gym_id uuid, p_renewal_id uuid, p_replayed boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'replayed', p_replayed,
        'renewal', jsonb_build_object('id', r.id, 'plan_price', r.plan_price, 'fee', r.fee,
            'amount_paid', r.amount_paid, 'start_choice', r.start_choice, 'created_at', r.created_at,
            'discount_amount', r.discount_amount, 'discount_reason', r.discount_reason),
        'membership', to_jsonb(mm.*) || jsonb_build_object('grace_until', mm.end_date + mm.grace_days),
        'payment', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id', p.id,
            'receipt_number', p.receipt_number, 'amount', p.amount, 'method', p.method, 'paid_on', p.paid_on,
            'discount_amount', p.discount_amount, 'discount_reason', p.discount_reason) END,
        'balance', jsonb_build_object(
            'billed', coalesce((SELECT sum(total_fees) FROM public.member_memberships
                WHERE gym_id = r.gym_id AND member_id = r.member_id AND status <> 'cancelled'), 0),
            'paid', coalesce((SELECT sum(amount) FROM public.payments
                WHERE gym_id = r.gym_id AND member_id = r.member_id AND kind = 'plan' AND status = 'paid'), 0),
            'outstanding', greatest(
                coalesce((SELECT sum(total_fees) FROM public.member_memberships
                    WHERE gym_id = r.gym_id AND member_id = r.member_id AND status <> 'cancelled'), 0)
                - coalesce((SELECT sum(amount) FROM public.payments
                    WHERE gym_id = r.gym_id AND member_id = r.member_id AND kind = 'plan' AND status = 'paid'), 0), 0))
    )
    FROM public.membership_renewals r
    JOIN public.member_memberships mm ON mm.id = r.membership_id
    LEFT JOIN public.payments p ON p.id = r.payment_id
    WHERE r.id = p_renewal_id AND r.gym_id = p_gym_id;
$$;
REVOKE ALL ON FUNCTION public.gympulse_renewal_result(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.gympulse_gym_summary(p_gym_id uuid, p_months integer DEFAULT 6)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH today AS (
        SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d
    ),
    months AS (
        SELECT generate_series(
            date_trunc('month', (SELECT d FROM today)) - make_interval(months => greatest(1, least(p_months, 24)) - 1),
            date_trunc('month', (SELECT d FROM today)),
            interval '1 month'
        )::date AS month_start
    ),
    live_members AS (
        SELECT id, (created_at AT TIME ZONE 'Asia/Kolkata')::date AS joined_on
        FROM public.members
        WHERE gym_id = p_gym_id AND archived_at IS NULL
    ),
    current_memberships AS (
        SELECT mm.*
        FROM public.member_memberships mm
        JOIN live_members lm ON lm.id = mm.member_id
        WHERE mm.gym_id = p_gym_id AND mm.status <> 'cancelled'
          AND mm.start_date <= (SELECT d FROM today) AND mm.end_date >= (SELECT d FROM today)
    ),
    -- A renewal is any membership that is not the member's first one.
    renewals AS (
        SELECT mm.id, (mm.created_at AT TIME ZONE 'Asia/Kolkata')::date AS created_on
        FROM public.member_memberships mm
        WHERE mm.gym_id = p_gym_id AND mm.status <> 'cancelled'
          AND EXISTS (
              SELECT 1 FROM public.member_memberships earlier
              WHERE earlier.gym_id = mm.gym_id AND earlier.member_id = mm.member_id
                AND earlier.status <> 'cancelled' AND earlier.created_at < mm.created_at
          )
    ),
    -- Members whose membership ended in the last 30 days, and whether a later one exists.
    due AS (
        SELECT mm.member_id,
            bool_or(EXISTS (
                SELECT 1 FROM public.member_memberships later
                WHERE later.gym_id = mm.gym_id AND later.member_id = mm.member_id
                  AND later.status <> 'cancelled' AND later.start_date > mm.start_date
            )) AS renewed
        FROM public.member_memberships mm
        JOIN live_members lm ON lm.id = mm.member_id
        WHERE mm.gym_id = p_gym_id AND mm.status <> 'cancelled'
          AND mm.end_date >= (SELECT d FROM today) - 30 AND mm.end_date < (SELECT d FROM today)
        GROUP BY mm.member_id
    )
    SELECT jsonb_build_object(
        'today', (SELECT d FROM today),
        'total_members', (SELECT count(*) FROM live_members),
        'active_members', (SELECT count(DISTINCT member_id) FROM current_memberships),
        'new_members_this_month', (SELECT count(*) FROM live_members
            WHERE joined_on >= date_trunc('month', (SELECT d FROM today))::date),
        'expiring_in_7_days', (SELECT count(DISTINCT cm.member_id) FROM current_memberships cm
            WHERE cm.end_date <= (SELECT d FROM today) + 7
              AND NOT EXISTS (
                SELECT 1 FROM public.member_memberships q
                WHERE q.gym_id = cm.gym_id AND q.member_id = cm.member_id
                  AND q.status <> 'cancelled' AND q.start_date > cm.end_date)),
        'expiring_in_30_days', (SELECT count(DISTINCT cm.member_id) FROM current_memberships cm
            WHERE cm.end_date <= (SELECT d FROM today) + 30
              AND NOT EXISTS (
                SELECT 1 FROM public.member_memberships q
                WHERE q.gym_id = cm.gym_id AND q.member_id = cm.member_id
                  AND q.status <> 'cancelled' AND q.start_date > cm.end_date)),
        'outstanding_total', (SELECT coalesce(sum(outstanding), 0) FROM public.member_balances WHERE gym_id = p_gym_id),
        'members_with_balance', (SELECT count(*) FROM public.member_balances WHERE gym_id = p_gym_id AND outstanding > 0),
        'collected_this_month', (SELECT coalesce(sum(amount), 0) FROM public.payments
            WHERE gym_id = p_gym_id AND refunded_at IS NULL AND status = 'paid' AND paid_on >= date_trunc('month', (SELECT d FROM today))::date),
        'collected_all_time', (SELECT coalesce(sum(amount), 0) FROM public.payments WHERE gym_id = p_gym_id AND refunded_at IS NULL AND status = 'paid'),
        'renewals_this_month', (SELECT count(*) FROM renewals
            WHERE created_on >= date_trunc('month', (SELECT d FROM today))::date),
        'due_last_30_days', (SELECT count(*) FROM due),
        'renewed_last_30_days', (SELECT count(*) FROM due WHERE renewed),
        -- Members with a current membership and no check-in in the last 14 days.
        'inactive_members', (SELECT count(DISTINCT cm.member_id) FROM current_memberships cm
            WHERE NOT EXISTS (
                SELECT 1 FROM public.attendance a
                WHERE a.gym_id = p_gym_id AND a.member_id = cm.member_id
                  AND a.check_in_date > (SELECT d FROM today) - 14
            )),
        'months', (
            SELECT jsonb_agg(jsonb_build_object(
                'month', to_char(m.month_start, 'YYYY-MM'),
                'collected', (SELECT coalesce(sum(amount), 0) FROM public.payments
                    WHERE gym_id = p_gym_id AND refunded_at IS NULL AND status = 'paid' AND paid_on >= m.month_start
                      AND paid_on < (m.month_start + interval '1 month')::date),
                'members', (SELECT count(*) FROM live_members
                    WHERE joined_on < (m.month_start + interval '1 month')::date),
                'renewals', (SELECT count(*) FROM renewals
                    WHERE created_on >= m.month_start AND created_on < (m.month_start + interval '1 month')::date),
                -- Estimate: per member, fees of memberships started by the month end minus
                -- payments made by then, never below zero.
                'outstanding', (SELECT coalesce(sum(greatest(coalesce(b.billed, 0) - coalesce(p.paid, 0), 0)), 0)
                    FROM live_members lm
                    LEFT JOIN LATERAL (
                        SELECT sum(total_fees) AS billed FROM public.member_memberships
                        WHERE gym_id = p_gym_id AND member_id = lm.id AND status <> 'cancelled'
                          AND start_date < (m.month_start + interval '1 month')::date
                    ) b ON true
                    LEFT JOIN LATERAL (
                        SELECT sum(amount) AS paid FROM public.payments
                        WHERE gym_id = p_gym_id AND member_id = lm.id AND kind = 'plan' AND status = 'paid'
                          AND paid_on < (m.month_start + interval '1 month')::date
                    ) p ON true)
            ) ORDER BY m.month_start)
            FROM months m
        ),
        'active_by_plan', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('plan_name', plan_name, 'members', members) ORDER BY members DESC, plan_name), '[]'::jsonb)
            FROM (SELECT plan_name, count(DISTINCT member_id) AS members FROM current_memberships GROUP BY plan_name) plans
        )
    );
$$;

REVOKE ALL ON FUNCTION public.gympulse_gym_summary(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_gym_summary(uuid, integer) TO service_role;
