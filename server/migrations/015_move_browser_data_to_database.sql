-- 015: move what GymPulse kept only in the browser into the database.
-- Review before running in the Supabase SQL Editor. Safe to run more than once.
-- Every new column, view and function is scoped by gym_id; writes go through the
-- backend (service role); signed-in users can only read their own gym (RLS).

-- 1. Gym preferences (were in localStorage). NULL = not chosen yet, so the app uses its
--    default and the one-time "Move my saved data to the cloud" step fills only NULLs.
ALTER TABLE public.gym_settings
    ADD COLUMN IF NOT EXISTS language text,
    ADD COLUMN IF NOT EXISTS date_format text,
    ADD COLUMN IF NOT EXISTS expiry_reminder_days integer,
    ADD COLUMN IF NOT EXISTS payment_reminders boolean,
    ADD COLUMN IF NOT EXISTS inactivity_reminders boolean;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gym_settings_language_valid') THEN
        ALTER TABLE public.gym_settings ADD CONSTRAINT gym_settings_language_valid
            CHECK (language IS NULL OR language IN ('en', 'hi', 'mr'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gym_settings_date_format_valid') THEN
        ALTER TABLE public.gym_settings ADD CONSTRAINT gym_settings_date_format_valid
            CHECK (date_format IS NULL OR date_format IN ('DD MMM YYYY', 'DD/MM/YYYY'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gym_settings_expiry_reminder_days_range') THEN
        ALTER TABLE public.gym_settings ADD CONSTRAINT gym_settings_expiry_reminder_days_range
            CHECK (expiry_reminder_days IS NULL OR expiry_reminder_days BETWEEN 0 AND 90);
    END IF;
END;
$$;

-- 2. The expiry-reminder message (was in localStorage) is stored like the welcome message:
--    one body per gym and language; a missing row means "use the built-in default".
ALTER TABLE public.gym_message_templates DROP CONSTRAINT IF EXISTS gym_message_templates_key_valid;
ALTER TABLE public.gym_message_templates ADD CONSTRAINT gym_message_templates_key_valid
    CHECK (template_key IN ('welcome', 'expiry_reminder'));

-- 3. "Reminded" marks on Expiring soon (were in localStorage) become rows in the existing
--    whatsapp_messages log (reminder_type 'expiry'), tied to the membership and its end date,
--    so renewing a membership (new end date) starts it unreminded again.
ALTER TABLE public.whatsapp_messages
    ADD COLUMN IF NOT EXISTS membership_id uuid,
    ADD COLUMN IF NOT EXISTS membership_end_date date;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_messages_gym_membership_fkey') THEN
        ALTER TABLE public.whatsapp_messages ADD CONSTRAINT whatsapp_messages_gym_membership_fkey
            FOREIGN KEY (gym_id, membership_id) REFERENCES public.member_memberships (gym_id, id) ON DELETE RESTRICT;
    END IF;
    -- NOT VALID: applies to new rows only, so any older 'expiry' rows do not block the migration.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_messages_expiry_has_membership') THEN
        ALTER TABLE public.whatsapp_messages ADD CONSTRAINT whatsapp_messages_expiry_has_membership
            CHECK (reminder_type <> 'expiry' OR (membership_id IS NOT NULL AND membership_end_date IS NOT NULL)) NOT VALID;
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS whatsapp_messages_gym_membership_idx
    ON public.whatsapp_messages (gym_id, membership_id, membership_end_date)
    WHERE membership_id IS NOT NULL;

-- Same consent rule as migration 010, plus: a linked membership must belong to that member.
CREATE OR REPLACE FUNCTION public.gympulse_whatsapp_message_requires_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.members
        WHERE id = NEW.member_id AND gym_id = NEW.gym_id AND archived_at IS NULL AND whatsapp_opt_in
    ) THEN
        RAISE EXCEPTION 'This member has not agreed to receive WhatsApp messages.' USING ERRCODE = '23514';
    END IF;
    IF NEW.membership_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.member_memberships
        WHERE id = NEW.membership_id AND gym_id = NEW.gym_id AND member_id = NEW.member_id
    ) THEN
        RAISE EXCEPTION 'That membership does not belong to this member.' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_whatsapp_message_requires_consent() FROM PUBLIC, anon, authenticated;

-- 4. Fees, paid and balance per member, from memberships (plan price or the fee agreed at
--    assignment) and recorded payments. Same rule as the API: every non-cancelled membership's
--    fee, minus every payment. security_invoker: RLS on the base tables applies to readers.
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
    GROUP BY gym_id, member_id
) p ON p.gym_id = m.gym_id AND p.member_id = m.id
WHERE m.archived_at IS NULL;

REVOKE ALL ON public.member_balances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.member_balances TO authenticated, service_role;

-- 5. One call for the Overview, Analytics and Payments totals, so they cover every member
--    (the browser only ever has one page of members loaded). India dates throughout.
--    Revenue counts every payment, including archived members'; balances skip archived members.
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
        'expiring_in_7_days', (SELECT count(DISTINCT member_id) FROM current_memberships
            WHERE end_date <= (SELECT d FROM today) + 7),
        'expiring_in_30_days', (SELECT count(DISTINCT member_id) FROM current_memberships
            WHERE end_date <= (SELECT d FROM today) + 30),
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

-- 6. One current member per phone number in a gym. Until now only the browser checked this,
--    and only against the members it had loaded. Compares the last 10 digits, so +91 98765 43210
--    and 9876543210 count as the same. Archived members do not block a number.
--    If duplicates already exist, the index is skipped with a NOTICE; list them with:
--      SELECT gym_id, right(regexp_replace(phone, '\D', '', 'g'), 10) AS phone_key,
--             array_agg(full_name ORDER BY created_at) AS names
--      FROM public.members WHERE archived_at IS NULL
--      GROUP BY 1, 2 HAVING count(*) > 1;
--    then archive or correct them and run this migration again.
DO $$
BEGIN
    IF to_regclass('public.members_gym_phone_key') IS NOT NULL THEN
        RETURN;
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.members
        WHERE archived_at IS NULL
        GROUP BY gym_id, right(regexp_replace(phone, '\D', '', 'g'), 10)
        HAVING count(*) > 1
    ) THEN
        RAISE NOTICE 'Some gyms have two current members with the same phone number; the unique phone index was not created. See the query in migration 015, part 6.';
    ELSE
        CREATE UNIQUE INDEX members_gym_phone_key
            ON public.members (gym_id, right(regexp_replace(phone, '\D', '', 'g'), 10))
            WHERE archived_at IS NULL;
    END IF;
END;
$$;
