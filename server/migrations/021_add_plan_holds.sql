-- 021: plan holds (pause a membership while a member is away, then continue the remaining days).
-- Review before running in the Supabase SQL Editor. Safe to run more than once.
-- Run it only after migration 020 has been run AND the grace/lapsed code is deployed: the end of
-- this file removes the old (019) renewal function that the earlier app version still calls.
--
-- * membership_holds: one row per hold. Writes only through the functions below (service role);
--   gym users can read their own gym's rows (RLS).
-- * A hold ends at the earliest of: its planned return date, the member's first check-in, staff
--   tapping Resume, or its maximum length. Nothing needs a nightly job: gympulse_settle_holds()
--   closes any hold whose date has passed, and the app calls it before it works out statuses.
-- * Ending a hold moves the plan's end later by the days actually held (resume day - start day),
--   which is the same as resume day + remaining days - 1. A plan already booked after it moves
--   later by the same days.
-- * A hold fee is a payment of kind 'hold_fee'. It counts as money collected but not towards the
--   member's plan balance. Payments are never deleted (receipt numbers stay complete), so
--   cancelling the hold marks the fee payment refunded; refunded payments leave the collected totals.

-- ---------- Settings ----------
ALTER TABLE public.membership_plans
    ADD COLUMN IF NOT EXISTS max_hold_days integer,
    ADD COLUMN IF NOT EXISTS max_holds integer;
ALTER TABLE public.gyms
    ADD COLUMN IF NOT EXISTS min_hold_days integer NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS hold_fee_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS hold_fee_amount numeric(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'plan',
    ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
    ADD COLUMN IF NOT EXISTS refunded_by uuid;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_plans_hold_limits_range') THEN
        ALTER TABLE public.membership_plans ADD CONSTRAINT membership_plans_hold_limits_range CHECK (
            (max_hold_days IS NULL OR max_hold_days BETWEEN 1 AND 365)
            AND (max_holds IS NULL OR max_holds BETWEEN 0 AND 12));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gyms_hold_settings_valid') THEN
        ALTER TABLE public.gyms ADD CONSTRAINT gyms_hold_settings_valid CHECK (
            min_hold_days BETWEEN 0 AND 365 AND hold_fee_amount >= 0
            AND (NOT hold_fee_enabled OR hold_fee_amount > 0));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_kind_valid') THEN
        ALTER TABLE public.payments ADD CONSTRAINT payments_kind_valid CHECK (kind IN ('plan', 'hold_fee'));
    END IF;
    -- Only a hold fee can be refunded (when its hold is cancelled).
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_refund_valid') THEN
        ALTER TABLE public.payments ADD CONSTRAINT payments_refund_valid CHECK (refunded_at IS NULL OR kind = 'hold_fee');
    END IF;
END;
$$;

-- ---------- Holds ----------
CREATE TABLE IF NOT EXISTS public.membership_holds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id uuid NOT NULL REFERENCES public.gyms (id) ON DELETE CASCADE,
    member_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    starts_on date NOT NULL,
    planned_return_on date,                 -- null = "Until they come back"
    latest_return_on date NOT NULL,         -- starts_on + the plan's max hold days
    ended_on date,                          -- null while the hold is running (or not started yet)
    end_reason text,
    remaining_days integer NOT NULL,        -- starts_on to the plan's end, inclusive
    days_held integer,
    end_before date NOT NULL,               -- the plan's end date when the hold was started
    end_after date,                         -- the plan's end date after the hold ended
    fee_amount numeric(12, 2) NOT NULL DEFAULT 0,
    fee_payment_id uuid REFERENCES public.payments (id) ON DELETE SET NULL,
    approved_by uuid,
    ended_by uuid,
    cancelled boolean NOT NULL DEFAULT false,
    cancelled_at timestamptz,
    cancelled_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT membership_holds_member_fkey
        FOREIGN KEY (gym_id, member_id) REFERENCES public.members (gym_id, id) ON DELETE CASCADE,
    CONSTRAINT membership_holds_membership_fkey
        FOREIGN KEY (gym_id, membership_id) REFERENCES public.member_memberships (gym_id, id) ON DELETE CASCADE,
    CONSTRAINT membership_holds_key UNIQUE (gym_id, idempotency_key),
    CONSTRAINT membership_holds_dates CHECK (
        latest_return_on > starts_on
        AND (planned_return_on IS NULL OR (planned_return_on > starts_on AND planned_return_on <= latest_return_on))
        AND (ended_on IS NULL OR (ended_on >= starts_on AND ended_on <= latest_return_on))),
    CONSTRAINT membership_holds_ended CHECK (
        (ended_on IS NULL AND end_reason IS NULL AND days_held IS NULL AND end_after IS NULL)
        OR (ended_on IS NOT NULL AND end_reason IN ('return_date', 'check_in', 'resumed', 'max_days')
            AND days_held = ended_on - starts_on AND end_after = end_before + days_held)),
    CONSTRAINT membership_holds_amounts CHECK (remaining_days > 0 AND fee_amount >= 0),
    CONSTRAINT membership_holds_cancelled CHECK (cancelled = (cancelled_at IS NOT NULL))
);
-- One open hold per member at a time.
CREATE UNIQUE INDEX IF NOT EXISTS membership_holds_one_open
    ON public.membership_holds (gym_id, member_id) WHERE NOT cancelled AND ended_on IS NULL;
CREATE INDEX IF NOT EXISTS membership_holds_membership_idx
    ON public.membership_holds (gym_id, membership_id);

ALTER TABLE public.membership_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_holds FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.membership_holds TO authenticated, service_role;
DROP POLICY IF EXISTS membership_holds_select_own_gym ON public.membership_holds;
CREATE POLICY membership_holds_select_own_gym ON public.membership_holds
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));

-- The "Send welcome back message" after a hold is logged in the WhatsApp history.
ALTER TABLE public.whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_reminder_type_valid;
ALTER TABLE public.whatsapp_messages ADD CONSTRAINT whatsapp_messages_reminder_type_valid
    CHECK (reminder_type IN ('welcome', 'expiry', 'payment', 'inactive', 'lapsed', 'hold_return'));

-- ---------- Hold limits: the plan's own, else by plan length ----------
-- up to 31 days: no holds; up to 100: 30 days, 1 hold; up to 190: 30 days, 2 holds; longer: 60 days, 2 holds.
CREATE OR REPLACE FUNCTION public.gympulse_hold_limits(p_max_hold_days integer, p_max_holds integer, p_duration_days integer)
RETURNS TABLE (max_hold_days integer, max_holds integer)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT coalesce(p_max_hold_days, CASE WHEN p_duration_days <= 31 THEN 30 WHEN p_duration_days <= 190 THEN 30 ELSE 60 END),
           coalesce(p_max_holds, CASE WHEN p_duration_days <= 31 THEN 0 WHEN p_duration_days <= 100 THEN 1 ELSE 2 END);
$$;
REVOKE ALL ON FUNCTION public.gympulse_hold_limits(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_hold_limits(integer, integer, integer) TO service_role;

-- ---------- No new plan while a hold is running ----------
-- Covers renewing, assigning a plan and importing. ("Resume the plan first")
CREATE OR REPLACE FUNCTION public.gympulse_no_new_plan_on_hold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.membership_holds
        WHERE gym_id = NEW.gym_id AND member_id = NEW.member_id AND NOT cancelled AND ended_on IS NULL
          AND starts_on <= (now() AT TIME ZONE 'Asia/Kolkata')::date
    ) THEN
        RAISE EXCEPTION 'This member''s plan is on hold. Resume the plan first.' USING ERRCODE = 'P0001', DETAIL = 'on_hold';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_no_new_plan_on_hold() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS member_memberships_no_new_plan_on_hold ON public.member_memberships;
CREATE TRIGGER member_memberships_no_new_plan_on_hold
    BEFORE INSERT ON public.member_memberships
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_no_new_plan_on_hold();

-- ---------- What the app is told about a hold ----------
CREATE OR REPLACE FUNCTION public.gympulse_hold_result(p_gym_id uuid, p_hold_id uuid, p_replayed boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'replayed', p_replayed,
        'hold', to_jsonb(h.*),
        'membership', to_jsonb(mm.*) || jsonb_build_object('grace_until', mm.end_date + mm.grace_days),
        'payment', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id', p.id,
            'receipt_number', p.receipt_number, 'amount', p.amount, 'method', p.method, 'paid_on', p.paid_on, 'kind', p.kind, 'refunded_at', p.refunded_at) END,
        'moved_plans', coalesce((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'start_date', f.start_date, 'end_date', f.end_date) ORDER BY f.start_date)
            FROM public.member_memberships f
            WHERE f.gym_id = h.gym_id AND f.member_id = h.member_id AND f.status <> 'cancelled' AND f.start_date > mm.end_date), '[]'::jsonb))
    FROM public.membership_holds h
    JOIN public.member_memberships mm ON mm.id = h.membership_id AND mm.gym_id = h.gym_id
    LEFT JOIN public.payments p ON p.id = h.fee_payment_id
    WHERE h.id = p_hold_id AND h.gym_id = p_gym_id;
$$;
REVOKE ALL ON FUNCTION public.gympulse_hold_result(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

-- ---------- Ending a hold (internal; the caller has locked the member) ----------
CREATE OR REPLACE FUNCTION public.gympulse_finish_hold(p_hold_id uuid, p_resume date, p_reason text, p_by uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hold public.membership_holds%ROWTYPE;
    v_held integer;
    v_next record;
    v_legacy_start date;
    v_legacy_end date;
    v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
    SELECT * INTO v_hold FROM public.membership_holds WHERE id = p_hold_id FOR UPDATE;
    IF NOT FOUND OR v_hold.cancelled OR v_hold.ended_on IS NOT NULL THEN
        RETURN;
    END IF;
    v_held := greatest(p_resume - v_hold.starts_on, 0);
    IF v_held > 0 THEN
        -- Plans booked after this one move first, latest first, so no two ever overlap.
        FOR v_next IN
            SELECT id FROM public.member_memberships
            WHERE gym_id = v_hold.gym_id AND member_id = v_hold.member_id AND status <> 'cancelled'
              AND id <> v_hold.membership_id AND start_date > v_hold.end_before
            ORDER BY start_date DESC
        LOOP
            UPDATE public.member_memberships SET start_date = start_date + v_held, end_date = end_date + v_held
            WHERE id = v_next.id;
        END LOOP;
        UPDATE public.member_memberships SET end_date = v_hold.end_before + v_held
        WHERE id = v_hold.membership_id AND gym_id = v_hold.gym_id;
    END IF;
    UPDATE public.membership_holds
    SET ended_on = v_hold.starts_on + v_held, end_reason = p_reason, days_held = v_held,
        end_after = v_hold.end_before + v_held, ended_by = p_by
    WHERE id = p_hold_id;

    SELECT start_date, end_date INTO v_legacy_start, v_legacy_end
    FROM public.member_memberships
    WHERE gym_id = v_hold.gym_id AND member_id = v_hold.member_id AND status <> 'cancelled' AND end_date >= v_today
    ORDER BY CASE WHEN start_date <= v_today THEN 0 ELSE 1 END, start_date ASC, created_at ASC
    LIMIT 1;
    UPDATE public.members SET membership_start_date = coalesce(v_legacy_start, membership_start_date),
        membership_end_date = coalesce(v_legacy_end, membership_end_date), updated_at = now()
    WHERE id = v_hold.member_id AND gym_id = v_hold.gym_id;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_finish_hold(uuid, date, text, uuid) FROM PUBLIC, anon, authenticated;

-- ---------- Closing holds whose return date or maximum has passed ----------
-- p_member_id null = the whole gym. Returns how many holds it closed.
CREATE OR REPLACE FUNCTION public.gympulse_settle_holds(p_gym_id uuid, p_member_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_hold record;
    v_count integer := 0;
BEGIN
    FOR v_hold IN
        SELECT h.id, h.member_id,
               least(coalesce(h.planned_return_on, h.latest_return_on), h.latest_return_on) AS back_on,
               CASE WHEN h.planned_return_on IS NOT NULL THEN 'return_date' ELSE 'max_days' END AS reason
        FROM public.membership_holds h
        WHERE h.gym_id = p_gym_id AND (p_member_id IS NULL OR h.member_id = p_member_id)
          AND NOT h.cancelled AND h.ended_on IS NULL
          AND least(coalesce(h.planned_return_on, h.latest_return_on), h.latest_return_on) <= v_today
        ORDER BY h.member_id
    LOOP
        PERFORM 1 FROM public.members WHERE id = v_hold.member_id AND gym_id = p_gym_id FOR UPDATE;
        PERFORM public.gympulse_finish_hold(v_hold.id, v_hold.back_on, v_hold.reason, NULL);
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_settle_holds(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_settle_holds(uuid, uuid) TO service_role;

-- ---------- Starting a hold ----------
-- p_starts_on: today or a later day within the plan. p_planned_return_on: null = until they come back.
-- p_fee_method / p_fee_upi_reference: used only when the gym charges a hold fee.
CREATE OR REPLACE FUNCTION public.gympulse_start_hold(
    p_gym_id uuid,
    p_member_id uuid,
    p_idempotency_key uuid,
    p_starts_on date,
    p_planned_return_on date,
    p_fee_method text,
    p_fee_upi_reference text,
    p_approved_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_existing public.membership_holds%ROWTYPE;
    v_gym public.gyms%ROWTYPE;
    v_mm public.member_memberships%ROWTYPE;
    v_plan_max_days integer;
    v_plan_max_holds integer;
    v_max_days integer;
    v_max_holds integer;
    v_used integer;
    v_min integer;
    v_payment public.payments%ROWTYPE;
    v_hold_id uuid;
BEGIN
    IF p_gym_id IS NULL OR p_member_id IS NULL OR p_idempotency_key IS NULL OR p_starts_on IS NULL THEN
        RAISE EXCEPTION 'Gym, member, start date and request key are required.' USING ERRCODE = '22004';
    END IF;
    PERFORM 1 FROM public.members
    WHERE id = p_member_id AND gym_id = p_gym_id AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member not found.' USING ERRCODE = 'P0002';
    END IF;

    -- A repeated request (same key) gets the first answer and changes nothing.
    SELECT * INTO v_existing FROM public.membership_holds
    WHERE gym_id = p_gym_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_existing.member_id <> p_member_id THEN
            RAISE EXCEPTION 'This request key belongs to another member.' USING ERRCODE = '22023';
        END IF;
        RETURN public.gympulse_hold_result(p_gym_id, v_existing.id, true);
    END IF;

    PERFORM public.gympulse_settle_holds(p_gym_id, p_member_id);
    IF EXISTS (SELECT 1 FROM public.membership_holds
               WHERE gym_id = p_gym_id AND member_id = p_member_id AND NOT cancelled AND ended_on IS NULL) THEN
        RAISE EXCEPTION 'This member already has a hold.' USING ERRCODE = 'P0001', DETAIL = 'already_on_hold';
    END IF;

    -- Only the plan running today (active or expiring), not one that ended or is still to start.
    SELECT * INTO v_mm FROM public.member_memberships
    WHERE gym_id = p_gym_id AND member_id = p_member_id AND status <> 'cancelled'
      AND start_date <= v_today AND end_date >= v_today
    ORDER BY end_date DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Only a running plan can be put on hold.' USING ERRCODE = 'P0001', DETAIL = 'not_running';
    END IF;
    IF p_starts_on < v_today OR p_starts_on > v_mm.end_date THEN
        RAISE EXCEPTION 'The hold must start between today and the plan''s last day (%).', to_char(v_mm.end_date, 'DD Mon YYYY')
            USING ERRCODE = 'P0001', DETAIL = 'start_outside_plan';
    END IF;

    SELECT max_hold_days, max_holds INTO v_plan_max_days, v_plan_max_holds
    FROM public.membership_plans WHERE id = v_mm.plan_id AND gym_id = p_gym_id;
    SELECT l.max_hold_days, l.max_holds INTO v_max_days, v_max_holds
    FROM public.gympulse_hold_limits(v_plan_max_days, v_plan_max_holds, v_mm.duration_days) l;
    IF v_max_holds = 0 THEN
        RAISE EXCEPTION '% plans can''t be put on hold.', v_mm.plan_name USING ERRCODE = 'P0001', DETAIL = 'holds_not_allowed';
    END IF;
    SELECT count(*) INTO v_used FROM public.membership_holds
    WHERE gym_id = p_gym_id AND membership_id = v_mm.id AND NOT cancelled;
    IF v_used >= v_max_holds THEN
        RAISE EXCEPTION '%', CASE WHEN v_max_holds = 1 THEN 'The hold on this plan is already used.'
            WHEN v_max_holds = 2 THEN 'Both holds already used.' ELSE format('All %s holds already used.', v_max_holds) END
            USING ERRCODE = 'P0001', DETAIL = 'no_holds_left';
    END IF;

    SELECT * INTO v_gym FROM public.gyms WHERE id = p_gym_id;
    v_min := greatest(coalesce(v_gym.min_hold_days, 0), 1);
    IF p_planned_return_on IS NOT NULL AND p_planned_return_on < p_starts_on + v_min THEN
        RAISE EXCEPTION 'The return date must be at least % days after the hold starts.', v_min
            USING ERRCODE = 'P0001', DETAIL = 'return_too_soon';
    END IF;
    IF p_planned_return_on IS NOT NULL AND p_planned_return_on > p_starts_on + v_max_days THEN
        RAISE EXCEPTION 'A hold on this plan can last at most % days.', v_max_days
            USING ERRCODE = 'P0001', DETAIL = 'return_too_late';
    END IF;

    IF v_gym.hold_fee_enabled AND v_gym.hold_fee_amount > 0 THEN
        IF p_fee_method IS NULL THEN
            RAISE EXCEPTION 'Choose how the hold fee was paid.' USING ERRCODE = '22004';
        END IF;
        INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method, paid_on, note, upi_reference, kind)
        VALUES (p_gym_id, p_member_id, v_mm.id, v_gym.hold_fee_amount, p_fee_method, v_today, 'Hold fee',
                CASE WHEN p_fee_method = 'upi' THEN nullif(btrim(p_fee_upi_reference), '') END, 'hold_fee')
        RETURNING * INTO v_payment;
    END IF;

    INSERT INTO public.membership_holds (
        gym_id, member_id, membership_id, idempotency_key, starts_on, planned_return_on, latest_return_on,
        remaining_days, end_before, fee_amount, fee_payment_id, approved_by
    ) VALUES (
        p_gym_id, p_member_id, v_mm.id, p_idempotency_key, p_starts_on, p_planned_return_on, p_starts_on + v_max_days,
        v_mm.end_date - p_starts_on + 1, v_mm.end_date, coalesce(v_payment.amount, 0), v_payment.id, p_approved_by
    ) RETURNING id INTO v_hold_id;

    RETURN public.gympulse_hold_result(p_gym_id, v_hold_id, false);
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_start_hold(uuid, uuid, uuid, date, date, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_start_hold(uuid, uuid, uuid, date, date, text, text, uuid) TO service_role;

-- ---------- Resuming (staff tapped Resume, or the member checked in) ----------
-- Repeating it after the hold has ended returns the same answer and changes nothing.
CREATE OR REPLACE FUNCTION public.gympulse_resume_hold(p_gym_id uuid, p_hold_id uuid, p_reason text, p_by uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_hold public.membership_holds%ROWTYPE;
BEGIN
    IF p_reason NOT IN ('resumed', 'check_in') THEN
        RAISE EXCEPTION 'Unknown reason.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_hold FROM public.membership_holds WHERE id = p_hold_id AND gym_id = p_gym_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Hold not found.' USING ERRCODE = 'P0002';
    END IF;
    PERFORM 1 FROM public.members WHERE id = v_hold.member_id AND gym_id = p_gym_id FOR UPDATE;
    PERFORM public.gympulse_settle_holds(p_gym_id, v_hold.member_id);
    SELECT * INTO v_hold FROM public.membership_holds WHERE id = p_hold_id;
    IF v_hold.cancelled THEN
        RAISE EXCEPTION 'This hold was cancelled.' USING ERRCODE = 'P0001', DETAIL = 'hold_cancelled';
    END IF;
    IF v_hold.ended_on IS NOT NULL THEN
        RETURN public.gympulse_hold_result(p_gym_id, p_hold_id, true);
    END IF;
    IF v_hold.starts_on > v_today THEN
        RAISE EXCEPTION 'This hold has not started yet. Cancel it instead.' USING ERRCODE = 'P0001', DETAIL = 'not_started';
    END IF;
    PERFORM public.gympulse_finish_hold(p_hold_id, v_today, p_reason, p_by);
    RETURN public.gympulse_hold_result(p_gym_id, p_hold_id, false);
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_resume_hold(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_resume_hold(uuid, uuid, text, uuid) TO service_role;

-- ---------- Cancelling (on or before the day it starts): as if it never happened ----------
-- It no longer counts as one of the member's holds, and a hold fee is marked refunded (the payment
-- and its receipt number stay). Repeating it is harmless.
CREATE OR REPLACE FUNCTION public.gympulse_cancel_hold(p_gym_id uuid, p_hold_id uuid, p_by uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_hold public.membership_holds%ROWTYPE;
BEGIN
    SELECT * INTO v_hold FROM public.membership_holds WHERE id = p_hold_id AND gym_id = p_gym_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Hold not found.' USING ERRCODE = 'P0002';
    END IF;
    PERFORM 1 FROM public.members WHERE id = v_hold.member_id AND gym_id = p_gym_id FOR UPDATE;
    SELECT * INTO v_hold FROM public.membership_holds WHERE id = p_hold_id FOR UPDATE;
    IF v_hold.cancelled THEN
        RETURN public.gympulse_hold_result(p_gym_id, p_hold_id, true);
    END IF;
    -- On its start day nothing has been extended yet (0 days held), so there is nothing to undo.
    IF v_today > v_hold.starts_on THEN
        RAISE EXCEPTION 'A hold can only be cancelled on the day it starts. Resume it instead.'
            USING ERRCODE = 'P0001', DETAIL = 'too_late_to_cancel';
    END IF;
    UPDATE public.membership_holds
    SET cancelled = true, cancelled_at = now(), cancelled_by = p_by,
        ended_on = NULL, end_reason = NULL, days_held = NULL, end_after = NULL, ended_by = NULL
    WHERE id = p_hold_id;
    UPDATE public.payments SET refunded_at = now(), refunded_by = p_by
    WHERE id = v_hold.fee_payment_id AND gym_id = p_gym_id AND kind = 'hold_fee' AND refunded_at IS NULL;
    RETURN public.gympulse_hold_result(p_gym_id, p_hold_id, false);
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_cancel_hold(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_cancel_hold(uuid, uuid, uuid) TO service_role;

-- ---------- Balances: a hold fee is collected money, not a payment towards plans ----------
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
    WHERE kind = 'plan'
    GROUP BY gym_id, member_id
) p ON p.gym_id = m.gym_id AND p.member_id = m.id
WHERE m.archived_at IS NULL;
REVOKE ALL ON public.member_balances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.member_balances TO authenticated, service_role;


-- ---------- Balances count plan payments only; collected money leaves out refunds ----------
-- (Same as migrations 020 and 019, with "AND kind = 'plan'" added where payments are summed
-- towards the balance, and refunded payments left out of money collected. Hold fees that were
-- not refunded still count as collected.)
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
                WHERE gym_id = r.gym_id AND member_id = r.member_id AND kind = 'plan'), 0),
            'outstanding', greatest(
                coalesce((SELECT sum(total_fees) FROM public.member_memberships
                    WHERE gym_id = r.gym_id AND member_id = r.member_id AND status <> 'cancelled'), 0)
                - coalesce((SELECT sum(amount) FROM public.payments
                    WHERE gym_id = r.gym_id AND member_id = r.member_id AND kind = 'plan'), 0), 0))
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
            WHERE gym_id = p_gym_id AND refunded_at IS NULL AND paid_on >= date_trunc('month', (SELECT d FROM today))::date),
        'collected_all_time', (SELECT coalesce(sum(amount), 0) FROM public.payments WHERE gym_id = p_gym_id AND refunded_at IS NULL),
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
                    WHERE gym_id = p_gym_id AND refunded_at IS NULL AND paid_on >= m.month_start
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
                        WHERE gym_id = p_gym_id AND member_id = lm.id AND kind = 'plan'
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

-- ---------- Clean-up: the 019 renewal function (the app now uses the 020 version) ----------
DROP FUNCTION IF EXISTS public.gympulse_renew_member(uuid, uuid, uuid, uuid, boolean, date, numeric, numeric, text, text, uuid);
