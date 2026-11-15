-- 016: import members from an owner's spreadsheet in one go.
-- Review before running in the Supabase SQL Editor. Safe to run more than once.
--
-- gympulse_import_members saves new plans, members, their plans (with the dates from the file)
-- and the amounts already paid in a single transaction: if any row fails, nothing is saved and
-- the error names the row. The backend calls it (service role) only for the gym's owner, after
-- checking every row; the function checks again and scopes everything to p_gym_id.
-- Imported members never get WhatsApp or photo consent: those columns keep their defaults (off),
-- and no message is sent or logged.
--
-- p_payload = {
--   "update_existing": false,            -- true: a phone that is already a member updates them
--   "new_plans": [{ "ref": "new-1", "name": "Gold", "duration_days": 90, "price": 2500 }],
--   "rows": [{ "row": 2, "full_name": "Riya Shah", "phone": "9876543210", "notes": null,
--              "plan": { "id": "<uuid>" } | { "ref": "new-1" } | null,
--              "start_date": "2026-11-01", "end_date": "2026-11-30", "amount_paid": 1500 }]
-- }

CREATE OR REPLACE FUNCTION public.gympulse_import_members(
    p_gym_id uuid,
    p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_update boolean := coalesce((p_payload->>'update_existing')::boolean, false);
    v_rows jsonb := p_payload->'rows';
    v_new_plans jsonb := coalesce(p_payload->'new_plans', '[]'::jsonb);
    v_plan_refs jsonb := '{}'::jsonb;
    v_new_plan record;
    v_plan public.membership_plans%ROWTYPE;
    v_plan_id uuid;
    v_row jsonb;
    v_row_number integer;
    v_name text;
    v_phone text;
    v_notes text;
    v_existing record;
    v_member_id uuid;
    v_membership_id uuid;
    v_start date;
    v_end date;
    v_amount numeric;
    v_seen text[] := ARRAY[]::text[];
    v_touched uuid[] := ARRAY[]::uuid[];
    v_created integer := 0;
    v_updated integer := 0;
    v_memberships integer := 0;
    v_payments integer := 0;
    v_plans integer := 0;
BEGIN
    IF p_gym_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.gyms WHERE id = p_gym_id) THEN
        RAISE EXCEPTION 'Gym not found.' USING ERRCODE = 'P0002';
    END IF;
    IF v_rows IS NULL OR jsonb_typeof(v_rows) <> 'array' OR jsonb_array_length(v_rows) = 0 THEN
        RAISE EXCEPTION 'There are no members to import.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_rows) > 2000 THEN
        RAISE EXCEPTION 'Import at most 2000 members at a time.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_new_plans) <> 'array' OR jsonb_array_length(v_new_plans) > 50 THEN
        RAISE EXCEPTION 'Create at most 50 plans in one import.' USING ERRCODE = '22023';
    END IF;

    -- One import per gym at a time, so two owners' imports cannot interleave.
    PERFORM pg_advisory_xact_lock(hashtextextended('gympulse_import_members:' || p_gym_id::text, 0));

    -- New plans first, so rows can use them.
    FOR v_new_plan IN SELECT * FROM jsonb_to_recordset(v_new_plans) AS plan(ref text, name text, duration_days integer, price numeric) LOOP
        IF coalesce(btrim(v_new_plan.ref), '') = '' OR coalesce(btrim(v_new_plan.name), '') = '' OR char_length(btrim(v_new_plan.name)) > 120 THEN
            RAISE EXCEPTION 'Each new plan needs a name of up to 120 characters.' USING ERRCODE = '22023';
        END IF;
        IF v_new_plan.duration_days IS NULL OR v_new_plan.duration_days < 1 OR v_new_plan.duration_days > 3650 THEN
            RAISE EXCEPTION 'The new plan "%" needs a length of 1 to 3650 days.', btrim(v_new_plan.name) USING ERRCODE = '22023';
        END IF;
        IF v_new_plan.price IS NULL OR v_new_plan.price < 0 OR v_new_plan.price > 10000000 THEN
            RAISE EXCEPTION 'The new plan "%" needs a price of 0 or more.', btrim(v_new_plan.name) USING ERRCODE = '22023';
        END IF;
        IF v_plan_refs ? v_new_plan.ref THEN
            RAISE EXCEPTION 'Two new plans use the same reference.' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (
            SELECT 1 FROM public.membership_plans
            WHERE gym_id = p_gym_id AND lower(btrim(name)) = lower(btrim(v_new_plan.name))
        ) THEN
            RAISE EXCEPTION 'A plan called "%" already exists. Choose it instead of creating it.', btrim(v_new_plan.name) USING ERRCODE = '23505';
        END IF;
        INSERT INTO public.membership_plans (gym_id, name, duration_days, price, is_active)
        VALUES (p_gym_id, btrim(v_new_plan.name), v_new_plan.duration_days, round(v_new_plan.price, 2), true)
        RETURNING id INTO v_plan_id;
        v_plan_refs := v_plan_refs || jsonb_build_object(v_new_plan.ref, v_plan_id);
        v_plans := v_plans + 1;
    END LOOP;

    FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
        v_row_number := CASE WHEN v_row->>'row' ~ '^[0-9]{1,7}$' THEN (v_row->>'row')::integer ELSE NULL END;
        IF v_row_number IS NULL THEN
            RAISE EXCEPTION 'Each member needs the row number from the file.' USING ERRCODE = '22023';
        END IF;
        v_name := btrim(regexp_replace(coalesce(v_row->>'full_name', ''), '\s+', ' ', 'g'));
        v_phone := coalesce(v_row->>'phone', '');
        v_notes := nullif(btrim(coalesce(v_row->>'notes', '')), '');
        IF v_name = '' OR char_length(v_name) > 200 THEN
            RAISE EXCEPTION 'Row %: the name is missing or too long.', v_row_number USING ERRCODE = '22023';
        END IF;
        IF v_phone !~ '^[6-9][0-9]{9}$' THEN
            RAISE EXCEPTION 'Row %: the phone number is not a 10-digit Indian mobile number.', v_row_number USING ERRCODE = '22023';
        END IF;
        IF v_phone = ANY (v_seen) THEN
            RAISE EXCEPTION 'Row %: this phone number is on another row of the file.', v_row_number USING ERRCODE = '23505';
        END IF;
        IF v_notes IS NOT NULL AND char_length(v_notes) > 5000 THEN
            RAISE EXCEPTION 'Row %: the notes are longer than 5000 characters.', v_row_number USING ERRCODE = '22023';
        END IF;
        v_seen := v_seen || v_phone;

        -- The same comparison as the unique phone index (migration 015): the last 10 digits.
        SELECT id, full_name INTO v_existing
        FROM public.members
        WHERE gym_id = p_gym_id AND archived_at IS NULL
          AND right(regexp_replace(phone, '\D', '', 'g'), 10) = v_phone
        LIMIT 1
        FOR UPDATE;

        IF FOUND THEN
            IF NOT v_update THEN
                RAISE EXCEPTION 'Row %: % already has this phone number.', v_row_number, v_existing.full_name USING ERRCODE = '23505';
            END IF;
            UPDATE public.members
            SET full_name = v_name, notes = coalesce(v_notes, notes), updated_at = now()
            WHERE id = v_existing.id AND gym_id = p_gym_id;
            v_member_id := v_existing.id;
            v_updated := v_updated + 1;
        ELSE
            INSERT INTO public.members (gym_id, member_code, full_name, phone, notes, status, created_at, updated_at)
            VALUES (
                p_gym_id,
                'GP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
                v_name, v_phone, v_notes, 'active', now(), now()
            )
            RETURNING id INTO v_member_id;
            v_created := v_created + 1;
        END IF;

        v_amount := NULL;
        IF v_row ? 'amount_paid' AND jsonb_typeof(v_row->'amount_paid') = 'number' THEN
            v_amount := (v_row->>'amount_paid')::numeric;
        END IF;

        IF jsonb_typeof(v_row->'plan') = 'object' THEN
            v_plan_id := CASE
                WHEN v_row->'plan' ? 'ref' THEN (v_plan_refs->>(v_row->'plan'->>'ref'))::uuid
                WHEN (v_row->'plan'->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_row->'plan'->>'id')::uuid
                ELSE NULL
            END;
            SELECT * INTO v_plan FROM public.membership_plans WHERE id = v_plan_id AND gym_id = p_gym_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Row %: the plan is not one of this gym''s plans.', v_row_number USING ERRCODE = 'P0002';
            END IF;
            IF NOT v_plan.is_active THEN
                RAISE EXCEPTION 'Row %: the plan "%" is turned off. Turn it on in Plans or choose another plan.', v_row_number, v_plan.name USING ERRCODE = 'P0001';
            END IF;
            v_start := CASE WHEN v_row->>'start_date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (v_row->>'start_date')::date ELSE NULL END;
            v_end := CASE WHEN v_row->>'end_date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (v_row->>'end_date')::date ELSE NULL END;
            IF v_start IS NULL AND v_end IS NULL THEN
                RAISE EXCEPTION 'Row %: the plan needs a start date or an end date.', v_row_number USING ERRCODE = '22023';
            END IF;
            v_start := coalesce(v_start, v_end - v_plan.duration_days + 1);
            v_end := coalesce(v_end, v_start + v_plan.duration_days - 1);
            IF v_end < v_start THEN
                RAISE EXCEPTION 'Row %: the end date is before the start date.', v_row_number USING ERRCODE = '22023';
            END IF;
            IF v_start < DATE '1990-01-01' OR v_end > DATE '2100-12-31' THEN
                RAISE EXCEPTION 'Row %: the dates are outside 1990 to 2100.', v_row_number USING ERRCODE = '22023';
            END IF;
            IF EXISTS (
                SELECT 1 FROM public.member_memberships
                WHERE gym_id = p_gym_id AND member_id = v_member_id AND status <> 'cancelled'
                  AND start_date <= v_end AND end_date >= v_start
            ) THEN
                RAISE EXCEPTION 'Row %: % already has a plan during those dates.', v_row_number, v_name USING ERRCODE = '23P01';
            END IF;
            -- The dates come from the file, so the length is what the file says; the fee is the plan's price.
            INSERT INTO public.member_memberships (
                gym_id, member_id, plan_id, plan_name, duration_days, price, total_fees, start_date, end_date
            ) VALUES (
                p_gym_id, v_member_id, v_plan.id, v_plan.name, v_end - v_start + 1, v_plan.price, v_plan.price, v_start, v_end
            ) RETURNING id INTO v_membership_id;
            v_memberships := v_memberships + 1;
            v_touched := v_touched || v_member_id;

            IF v_amount IS NOT NULL AND v_amount > 0 THEN
                IF v_amount > 10000000 THEN
                    RAISE EXCEPTION 'Row %: the amount paid is too large.', v_row_number USING ERRCODE = '22023';
                END IF;
                INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method, paid_on, note)
                VALUES (p_gym_id, v_member_id, v_membership_id, round(v_amount, 2), 'other', least(v_start, v_today), 'Imported from a spreadsheet');
                v_payments := v_payments + 1;
            END IF;
        ELSIF v_amount IS NOT NULL AND v_amount > 0 THEN
            RAISE EXCEPTION 'Row %: an amount paid needs a plan.', v_row_number USING ERRCODE = '22023';
        ELSIF v_row ? 'plan' AND v_row->'plan' <> 'null'::jsonb THEN
            RAISE EXCEPTION 'Row %: the plan could not be read.', v_row_number USING ERRCODE = '22023';
        END IF;
    END LOOP;

    -- Keep the members table's older date columns in step, as assigning a plan does (migration 008).
    UPDATE public.members m
    SET membership_start_date = current_plan.start_date, membership_end_date = current_plan.end_date
    FROM (
        SELECT DISTINCT ON (member_id) member_id, start_date, end_date
        FROM public.member_memberships
        WHERE gym_id = p_gym_id AND member_id = ANY (v_touched) AND status <> 'cancelled' AND end_date >= v_today
        ORDER BY member_id, CASE WHEN start_date <= v_today THEN 0 ELSE 1 END, start_date ASC, created_at ASC
    ) current_plan
    WHERE m.id = current_plan.member_id AND m.gym_id = p_gym_id;

    RETURN jsonb_build_object(
        'created', v_created,
        'updated', v_updated,
        'memberships', v_memberships,
        'payments', v_payments,
        'plans_created', v_plans
    );
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_import_members(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_import_members(uuid, jsonb) TO service_role;
