-- 020: grace periods, lapsed members and the welcome-back discount.
-- Review before running in the Supabase SQL Editor. Safe to run more than once.
--
-- * Each membership carries its own grace_days, copied when it is created (from its plan, or
--   the gym's default), so changing a rule later only affects memberships created after that.
-- * The gym default (gyms.expiry_grace_days) becomes 3 where it was 0. That happens on the first
--   run only: running this again never undoes an owner who later sets 0 on purpose.
-- * Payments (and renewal records) keep any discount and why ('welcome_back' or 'manual').
-- * gympulse_renew_member gets a new version: the start date follows the new rules (the day
--   after a running plan ends, otherwise the renewal day, with the gap forgiven), the owner can
--   choose another start date, and discounts are saved. The previous version stays until a
--   later migration removes it, so the app keeps working between running this and deploying.

DO $$
DECLARE
    v_first_run boolean := NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'member_memberships' AND column_name = 'grace_days');
BEGIN
    -- ---------- Gym defaults ----------
    ALTER TABLE public.gyms ALTER COLUMN expiry_grace_days SET DEFAULT 3;
    IF v_first_run THEN
        UPDATE public.gyms SET expiry_grace_days = 3 WHERE coalesce(expiry_grace_days, 0) = 0;
    END IF;

    -- ---------- Each membership keeps the grace it was created with ----------
    ALTER TABLE public.member_memberships ADD COLUMN IF NOT EXISTS grace_days integer;
    IF v_first_run THEN
        UPDATE public.member_memberships mm SET grace_days = g.expiry_grace_days
        FROM public.gyms g WHERE g.id = mm.gym_id AND mm.grace_days IS NULL;
    END IF;
END;
$$;

ALTER TABLE public.gyms
    ADD COLUMN IF NOT EXISTS welcome_back_discount_type text NOT NULL DEFAULT 'percent',
    ADD COLUMN IF NOT EXISTS welcome_back_discount_value numeric(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lapsed_list_days integer NOT NULL DEFAULT 60;
ALTER TABLE public.membership_plans ADD COLUMN IF NOT EXISTS grace_days integer;
ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS discount_amount numeric(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS discount_reason text;
ALTER TABLE public.membership_renewals
    ADD COLUMN IF NOT EXISTS discount_amount numeric(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS discount_reason text;

-- Memberships that came from somewhere without a gym (very old rows) get 0, then the column is required.
UPDATE public.member_memberships SET grace_days = 0 WHERE grace_days IS NULL;
ALTER TABLE public.member_memberships ALTER COLUMN grace_days SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gyms_welcome_back_discount_valid') THEN
        ALTER TABLE public.gyms ADD CONSTRAINT gyms_welcome_back_discount_valid CHECK (
            welcome_back_discount_type IN ('amount', 'percent')
            AND welcome_back_discount_value >= 0
            AND (welcome_back_discount_type <> 'percent' OR welcome_back_discount_value <= 100));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gyms_lapsed_list_days_range') THEN
        ALTER TABLE public.gyms ADD CONSTRAINT gyms_lapsed_list_days_range CHECK (lapsed_list_days BETWEEN 7 AND 365);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_plans_grace_days_range') THEN
        ALTER TABLE public.membership_plans ADD CONSTRAINT membership_plans_grace_days_range CHECK (grace_days IS NULL OR grace_days BETWEEN 0 AND 60);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_memberships_grace_days_range') THEN
        ALTER TABLE public.member_memberships ADD CONSTRAINT member_memberships_grace_days_range CHECK (grace_days BETWEEN 0 AND 60);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_discount_valid') THEN
        ALTER TABLE public.payments ADD CONSTRAINT payments_discount_valid CHECK (
            discount_amount >= 0
            AND (discount_reason IS NULL OR discount_reason IN ('welcome_back', 'manual'))
            AND (discount_reason IS NULL OR discount_amount > 0));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_renewals_discount_valid') THEN
        ALTER TABLE public.membership_renewals ADD CONSTRAINT membership_renewals_discount_valid CHECK (
            discount_amount >= 0
            AND (discount_reason IS NULL OR discount_reason IN ('welcome_back', 'manual'))
            AND (discount_reason IS NULL OR discount_amount > 0));
    END IF;
END;
$$;

-- A renewal's start: after the running plan, the renewal day, or a date the owner chose.
-- ('after_old_plan' stays valid for renewals saved with migration 019.)
ALTER TABLE public.membership_renewals DROP CONSTRAINT IF EXISTS membership_renewals_start_choice_valid;
ALTER TABLE public.membership_renewals ADD CONSTRAINT membership_renewals_start_choice_valid
    CHECK (start_choice IN ('after_current', 'today', 'after_old_plan', 'owner_date'));

-- The "Send renewal message" to lapsed members is logged in the WhatsApp history.
ALTER TABLE public.whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_reminder_type_valid;
ALTER TABLE public.whatsapp_messages ADD CONSTRAINT whatsapp_messages_reminder_type_valid
    CHECK (reminder_type IN ('welcome', 'expiry', 'payment', 'inactive', 'lapsed'));

-- ---------- Grace is copied when a membership is created, whatever creates it ----------
-- (assigning a plan, importing, renewing, the demo seed). The plan's grace if it has one, else
-- the gym's default. Later changes to either never reach existing memberships.
CREATE OR REPLACE FUNCTION public.gympulse_membership_grace_days()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.grace_days IS NULL THEN
        NEW.grace_days := coalesce(
            (SELECT grace_days FROM public.membership_plans WHERE id = NEW.plan_id AND gym_id = NEW.gym_id),
            (SELECT expiry_grace_days FROM public.gyms WHERE id = NEW.gym_id),
            0);
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_membership_grace_days() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS member_memberships_grace_days ON public.member_memberships;
CREATE TRIGGER member_memberships_grace_days
    BEFORE INSERT ON public.member_memberships
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_membership_grace_days();

-- ---------- What the app is told about a renewal (now with grace and discount) ----------
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
                WHERE gym_id = r.gym_id AND member_id = r.member_id), 0),
            'outstanding', greatest(
                coalesce((SELECT sum(total_fees) FROM public.member_memberships
                    WHERE gym_id = r.gym_id AND member_id = r.member_id AND status <> 'cancelled'), 0)
                - coalesce((SELECT sum(amount) FROM public.payments
                    WHERE gym_id = r.gym_id AND member_id = r.member_id), 0), 0))
    )
    FROM public.membership_renewals r
    JOIN public.member_memberships mm ON mm.id = r.membership_id
    LEFT JOIN public.payments p ON p.id = r.payment_id
    WHERE r.id = p_renewal_id AND r.gym_id = p_gym_id;
$$;
REVOKE ALL ON FUNCTION public.gympulse_renewal_result(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

-- ---------- Renewing (new version) ----------
-- p_start_date: a start the owner chose, or null for the automatic one.
-- p_expected_start: the automatic start the screen showed; refused if it has changed since.
-- p_total_fees: what is charged (null = the plan's price). Less than the price is a discount,
-- saved with p_discount_reason ('welcome_back'), or 'manual' when the price was just edited.
CREATE OR REPLACE FUNCTION public.gympulse_renew_member(
    p_gym_id uuid,
    p_member_id uuid,
    p_idempotency_key uuid,
    p_plan_id uuid,
    p_start_date date,
    p_expected_start date,
    p_total_fees numeric,
    p_discount_reason text,
    p_amount_paid numeric,
    p_method text,
    p_upi_reference text,
    p_recorded_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_plan public.membership_plans%ROWTYPE;
    v_prev public.member_memberships%ROWTYPE;
    v_existing public.membership_renewals%ROWTYPE;
    v_membership public.member_memberships%ROWTYPE;
    v_payment public.payments%ROWTYPE;
    v_renewal_id uuid;
    v_queued date;
    v_auto date;
    v_start date;
    v_end date;
    v_choice text;
    v_fee numeric;
    v_paid numeric;
    v_discount numeric;
    v_reason text;
    v_legacy_start date;
    v_legacy_end date;
BEGIN
    IF p_gym_id IS NULL OR p_member_id IS NULL OR p_idempotency_key IS NULL OR p_plan_id IS NULL THEN
        RAISE EXCEPTION 'Gym, member, plan and request key are required.' USING ERRCODE = '22004';
    END IF;
    PERFORM 1 FROM public.members
    WHERE id = p_member_id AND gym_id = p_gym_id AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member not found.' USING ERRCODE = 'P0002';
    END IF;

    -- A repeated request (same key) gets the first answer and changes nothing.
    SELECT * INTO v_existing FROM public.membership_renewals
    WHERE gym_id = p_gym_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_existing.member_id <> p_member_id THEN
            RAISE EXCEPTION 'This request key belongs to another member.' USING ERRCODE = '22023';
        END IF;
        RETURN public.gympulse_renewal_result(p_gym_id, v_existing.id, true);
    END IF;

    SELECT * INTO v_plan FROM public.membership_plans
    WHERE id = p_plan_id AND gym_id = p_gym_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Plan not found.' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_plan.is_active THEN
        RAISE EXCEPTION 'Only active plans can be used for a renewal.' USING ERRCODE = 'P0001', DETAIL = 'plan_inactive';
    END IF;

    SELECT min(start_date) INTO v_queued FROM public.member_memberships
    WHERE gym_id = p_gym_id AND member_id = p_member_id AND status <> 'cancelled' AND start_date > v_today;
    IF v_queued IS NOT NULL THEN
        RAISE EXCEPTION 'This member already has a plan starting on %. Renewing now would overlap it.', to_char(v_queued, 'DD Mon YYYY')
            USING ERRCODE = 'P0001', DETAIL = 'future_plan';
    END IF;

    -- Before the plan ends: the day after it ends. After it ended (grace, lapsed, old) or no plan:
    -- the renewal day, full length; the gap is forgiven.
    SELECT * INTO v_prev FROM public.member_memberships
    WHERE gym_id = p_gym_id AND member_id = p_member_id AND status <> 'cancelled'
    ORDER BY end_date DESC, created_at DESC LIMIT 1;
    IF FOUND AND v_prev.start_date <= v_today AND v_prev.end_date >= v_today THEN
        v_auto := v_prev.end_date + 1;
        v_choice := 'after_current';
    ELSE
        v_auto := v_today;
        v_choice := 'today';
    END IF;
    IF p_expected_start IS NOT NULL AND p_expected_start <> v_auto THEN
        RAISE EXCEPTION 'The plan dates changed since this screen opened. Close it and renew again.'
            USING ERRCODE = 'P0001', DETAIL = 'dates_changed';
    END IF;
    v_start := coalesce(p_start_date, v_auto);
    IF v_start <> v_auto THEN
        v_choice := 'owner_date';
    END IF;
    v_end := v_start + v_plan.duration_days - 1;
    IF EXISTS (
        SELECT 1 FROM public.member_memberships
        WHERE gym_id = p_gym_id AND member_id = p_member_id AND status <> 'cancelled'
          AND start_date <= v_end AND end_date >= v_start
    ) THEN
        RAISE EXCEPTION 'This member already has a membership during those dates.' USING ERRCODE = '23P01';
    END IF;

    v_fee := coalesce(p_total_fees, v_plan.price);
    v_paid := coalesce(p_amount_paid, 0);
    IF v_fee < 0 THEN
        RAISE EXCEPTION 'The fee cannot be negative.' USING ERRCODE = '23514';
    END IF;
    IF v_paid < 0 OR v_paid > v_fee THEN
        RAISE EXCEPTION 'The amount paid must be between zero and the fee.' USING ERRCODE = '23514';
    END IF;
    v_discount := greatest(v_plan.price - v_fee, 0);
    v_reason := CASE WHEN v_discount = 0 THEN NULL
        WHEN p_discount_reason = 'welcome_back' THEN 'welcome_back' ELSE 'manual' END;

    INSERT INTO public.member_memberships (
        gym_id, member_id, plan_id, plan_name, duration_days, price, total_fees, start_date, end_date
    ) VALUES (
        p_gym_id, p_member_id, v_plan.id, v_plan.name, v_plan.duration_days, v_plan.price, v_fee, v_start, v_end
    ) RETURNING * INTO v_membership;

    IF v_paid > 0 THEN
        INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method, paid_on, note, upi_reference,
            discount_amount, discount_reason)
        VALUES (p_gym_id, p_member_id, v_membership.id, v_paid, p_method, v_today, 'Renewal',
                CASE WHEN p_method = 'upi' THEN nullif(btrim(p_upi_reference), '') END,
                v_discount, v_reason)
        RETURNING * INTO v_payment;
    END IF;

    INSERT INTO public.membership_renewals (
        gym_id, member_id, membership_id, previous_membership_id, payment_id, idempotency_key,
        plan_price, fee, amount_paid, start_choice, recorded_by, discount_amount, discount_reason
    ) VALUES (
        p_gym_id, p_member_id, v_membership.id, v_prev.id, v_payment.id, p_idempotency_key,
        v_plan.price, v_fee, v_paid, v_choice, p_recorded_by, v_discount, v_reason
    ) RETURNING id INTO v_renewal_id;

    SELECT start_date, end_date INTO v_legacy_start, v_legacy_end
    FROM public.member_memberships
    WHERE gym_id = p_gym_id AND member_id = p_member_id AND status <> 'cancelled' AND end_date >= v_today
    ORDER BY CASE WHEN start_date <= v_today THEN 0 ELSE 1 END, start_date ASC, created_at ASC
    LIMIT 1;
    UPDATE public.members SET membership_start_date = v_legacy_start,
        membership_end_date = v_legacy_end, updated_at = now()
    WHERE id = p_member_id AND gym_id = p_gym_id;

    RETURN public.gympulse_renewal_result(p_gym_id, v_renewal_id, false);
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_renew_member(uuid, uuid, uuid, uuid, date, date, numeric, text, numeric, text, text, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_renew_member(uuid, uuid, uuid, uuid, date, date, numeric, text, numeric, text, text, uuid)
    TO service_role;
