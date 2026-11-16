-- 019: one-tap renewal.
-- Review before running in the Supabase SQL Editor. Safe to run more than once.
--
-- gympulse_renew_member creates the member's next plan, records the payment and the renewal in
-- ONE transaction, scoped to p_gym_id: if any step fails (a plan that overlaps, a duplicate UTR,
-- a bad amount) nothing is saved. The start date is worked out here, not trusted from the app:
--   * a plan that is active or expiring: the day after it ends (no days lost, no overlap);
--   * expired, or no plan: today, or with p_backdate the day after the last plan ended;
--   * a plan already queued to start later: refused, instead of creating overlapping plans.
-- Every call carries an idempotency key. Repeating a call with the same key (double tap, slow
-- network, retry) returns the first result and creates nothing. The member row is locked first,
-- so two simultaneous calls cannot both pass the check.

CREATE TABLE IF NOT EXISTS public.membership_renewals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id uuid NOT NULL REFERENCES public.gyms (id) ON DELETE CASCADE,
    member_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    previous_membership_id uuid,
    payment_id uuid REFERENCES public.payments (id) ON DELETE SET NULL,
    idempotency_key uuid NOT NULL,
    plan_price numeric(12, 2) NOT NULL,
    fee numeric(12, 2) NOT NULL,
    amount_paid numeric(12, 2) NOT NULL DEFAULT 0,
    start_choice text NOT NULL,
    recorded_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT membership_renewals_member_fkey
        FOREIGN KEY (gym_id, member_id) REFERENCES public.members (gym_id, id) ON DELETE CASCADE,
    CONSTRAINT membership_renewals_membership_fkey
        FOREIGN KEY (gym_id, membership_id) REFERENCES public.member_memberships (gym_id, id) ON DELETE CASCADE,
    CONSTRAINT membership_renewals_key UNIQUE (gym_id, idempotency_key),
    CONSTRAINT membership_renewals_one_per_membership UNIQUE (membership_id),
    CONSTRAINT membership_renewals_amounts CHECK (plan_price >= 0 AND fee >= 0 AND amount_paid >= 0 AND amount_paid <= fee),
    CONSTRAINT membership_renewals_start_choice_valid CHECK (start_choice IN ('after_current', 'today', 'after_old_plan'))
);
CREATE INDEX IF NOT EXISTS membership_renewals_member_idx
    ON public.membership_renewals (gym_id, member_id, created_at DESC);

ALTER TABLE public.membership_renewals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_renewals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.membership_renewals TO authenticated;
GRANT SELECT ON public.membership_renewals TO service_role;
DROP POLICY IF EXISTS membership_renewals_select_own_gym ON public.membership_renewals;
CREATE POLICY membership_renewals_select_own_gym ON public.membership_renewals
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));

-- What the app is told about one renewal (used for a fresh save and for a repeated one).
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
            'amount_paid', r.amount_paid, 'start_choice', r.start_choice, 'created_at', r.created_at),
        'membership', to_jsonb(mm.*),
        'payment', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id', p.id,
            'receipt_number', p.receipt_number, 'amount', p.amount, 'method', p.method, 'paid_on', p.paid_on) END,
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

CREATE OR REPLACE FUNCTION public.gympulse_renew_member(
    p_gym_id uuid,
    p_member_id uuid,
    p_idempotency_key uuid,
    p_plan_id uuid,
    p_backdate boolean,
    p_expected_start date,
    p_total_fees numeric,
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
    v_active boolean;
    v_start date;
    v_end date;
    v_choice text;
    v_fee numeric;
    v_paid numeric;
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

    SELECT * INTO v_prev FROM public.member_memberships
    WHERE gym_id = p_gym_id AND member_id = p_member_id AND status <> 'cancelled'
    ORDER BY end_date DESC, created_at DESC LIMIT 1;
    v_active := FOUND AND v_prev.start_date <= v_today AND v_prev.end_date >= v_today;
    IF v_active THEN
        v_start := v_prev.end_date + 1;
        v_choice := 'after_current';
    ELSIF v_prev.id IS NOT NULL AND coalesce(p_backdate, false) THEN
        v_start := v_prev.end_date + 1;
        v_choice := 'after_old_plan';
    ELSE
        v_start := v_today;
        v_choice := 'today';
    END IF;
    IF p_expected_start IS NOT NULL AND p_expected_start <> v_start THEN
        RAISE EXCEPTION 'The plan dates changed since this screen opened. Close it and renew again.'
            USING ERRCODE = 'P0001', DETAIL = 'dates_changed';
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

    INSERT INTO public.member_memberships (
        gym_id, member_id, plan_id, plan_name, duration_days, price, total_fees, start_date, end_date
    ) VALUES (
        p_gym_id, p_member_id, v_plan.id, v_plan.name, v_plan.duration_days, v_plan.price, v_fee, v_start, v_end
    ) RETURNING * INTO v_membership;

    IF v_paid > 0 THEN
        INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method, paid_on, note, upi_reference)
        VALUES (p_gym_id, p_member_id, v_membership.id, v_paid, p_method, v_today, 'Renewal',
                CASE WHEN p_method = 'upi' THEN nullif(btrim(p_upi_reference), '') END)
        RETURNING * INTO v_payment;
    END IF;

    INSERT INTO public.membership_renewals (
        gym_id, member_id, membership_id, previous_membership_id, payment_id, idempotency_key,
        plan_price, fee, amount_paid, start_choice, recorded_by
    ) VALUES (
        p_gym_id, p_member_id, v_membership.id, v_prev.id, v_payment.id, p_idempotency_key,
        v_plan.price, v_fee, v_paid, v_choice, p_recorded_by
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

REVOKE ALL ON FUNCTION public.gympulse_renew_member(uuid, uuid, uuid, uuid, boolean, date, numeric, numeric, text, text, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_renew_member(uuid, uuid, uuid, uuid, boolean, date, numeric, numeric, text, text, uuid)
    TO service_role;

-- ---------- Overview totals: a member with a later plan queued is not "expiring" ----------
-- The same function as in migration 015; the only change is in 'expiring_in_7_days' and
-- 'expiring_in_30_days', which now skip a member whose current plan is followed by another one
-- (a renewal that has not started yet). Every other figure is unchanged.
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
            WHERE gym_id = p_gym_id AND paid_on >= date_trunc('month', (SELECT d FROM today))::date),
        'collected_all_time', (SELECT coalesce(sum(amount), 0) FROM public.payments WHERE gym_id = p_gym_id),
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
                    WHERE gym_id = p_gym_id AND paid_on >= m.month_start
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
                        WHERE gym_id = p_gym_id AND member_id = lm.id
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
