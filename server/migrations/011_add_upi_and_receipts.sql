-- 011: UPI settings per gym, server-assigned receipt numbers and UPI references on payments.

-- Gym details used on receipts and payment QR codes (previously kept only in the browser).
CREATE TABLE IF NOT EXISTS public.gym_settings (
    gym_id uuid PRIMARY KEY REFERENCES public.gyms (id) ON DELETE CASCADE,
    phone text,
    address text,
    upi_id text,
    upi_payee_name text,
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT gym_settings_upi_id_format
        CHECK (upi_id IS NULL OR upi_id ~ '^[A-Za-z0-9._-]{2,200}@[A-Za-z][A-Za-z0-9.-]{1,63}$'),
    CONSTRAINT gym_settings_upi_payee_name_length
        CHECK (upi_payee_name IS NULL OR char_length(btrim(upi_payee_name)) BETWEEN 1 AND 100),
    CONSTRAINT gym_settings_phone_length CHECK (phone IS NULL OR char_length(phone) <= 20),
    CONSTRAINT gym_settings_address_length CHECK (address IS NULL OR char_length(address) <= 300)
);
ALTER TABLE public.gym_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gym_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.gym_settings TO authenticated;
GRANT ALL ON public.gym_settings TO service_role;
DROP POLICY IF EXISTS gym_settings_select_own_gym ON public.gym_settings;
CREATE POLICY gym_settings_select_own_gym ON public.gym_settings
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));

-- One counter row per gym. Only the receipt trigger and the demo reset touch it.
CREATE TABLE IF NOT EXISTS public.gym_receipt_counters (
    gym_id uuid PRIMARY KEY REFERENCES public.gyms (id) ON DELETE CASCADE,
    last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);
ALTER TABLE public.gym_receipt_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gym_receipt_counters FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.gym_receipt_counters TO service_role;

ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS receipt_number text,
    ADD COLUMN IF NOT EXISTS upi_reference text;

-- R-000123; numbers past 999999 keep all their digits instead of being cut off.
CREATE OR REPLACE FUNCTION public.gympulse_format_receipt_number(p_number bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT 'R-' || CASE WHEN p_number < 1000000 THEN lpad(p_number::text, 6, '0') ELSE p_number::text END;
$$;

-- Number existing payments per gym, oldest first, then set each counter to its gym's last number.
WITH numbered AS (
    SELECT p.id, coalesce(c.last_number, 0)
        + row_number() OVER (PARTITION BY p.gym_id ORDER BY p.created_at, p.id) AS n
    FROM public.payments p
    LEFT JOIN public.gym_receipt_counters c ON c.gym_id = p.gym_id
    WHERE p.receipt_number IS NULL
)
UPDATE public.payments p
SET receipt_number = public.gympulse_format_receipt_number(numbered.n)
FROM numbered
WHERE p.id = numbered.id;

INSERT INTO public.gym_receipt_counters (gym_id, last_number)
SELECT gym_id, max(substring(receipt_number FROM 3)::bigint) FROM public.payments GROUP BY gym_id
ON CONFLICT (gym_id) DO UPDATE
    SET last_number = GREATEST(public.gym_receipt_counters.last_number, EXCLUDED.last_number);

ALTER TABLE public.payments ALTER COLUMN receipt_number SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_upi_reference_format') THEN
        ALTER TABLE public.payments ADD CONSTRAINT payments_upi_reference_format
            CHECK (upi_reference IS NULL OR upi_reference ~ '^[0-9]{12}$');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_upi_reference_needs_upi') THEN
        ALTER TABLE public.payments ADD CONSTRAINT payments_upi_reference_needs_upi
            CHECK (upi_reference IS NULL OR method = 'upi');
    END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS payments_gym_receipt_number_key
    ON public.payments (gym_id, receipt_number);
CREATE UNIQUE INDEX IF NOT EXISTS payments_gym_upi_reference_key
    ON public.payments (gym_id, upi_reference) WHERE upi_reference IS NOT NULL;

-- Every insert gets the gym's next number, whatever path inserts it (API or seed script).
-- The counter row stays locked until the transaction ends: two quick saves for the same gym
-- wait for each other (no duplicates), and if the payment fails (for example a duplicate UTR)
-- the whole transaction rolls back, increment included (no gaps). A number sent by a client is
-- ignored. Receipt numbers and the gym of a payment cannot be changed afterwards.
CREATE OR REPLACE FUNCTION public.gympulse_assign_receipt_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_number bigint;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.receipt_number IS DISTINCT FROM OLD.receipt_number OR NEW.gym_id IS DISTINCT FROM OLD.gym_id THEN
            RAISE EXCEPTION 'Receipt numbers cannot be changed.' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;
    INSERT INTO public.gym_receipt_counters AS c (gym_id, last_number)
    VALUES (NEW.gym_id, 1)
    ON CONFLICT (gym_id) DO UPDATE SET last_number = c.last_number + 1
    RETURNING last_number INTO v_number;
    NEW.receipt_number := public.gympulse_format_receipt_number(v_number);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_assign_receipt_number() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payments_assign_receipt_number ON public.payments;
CREATE TRIGGER payments_assign_receipt_number
    BEFORE INSERT OR UPDATE ON public.payments
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_assign_receipt_number();

-- Payments are kept so receipt numbers never have gaps. Only the demo reset below may delete.
CREATE OR REPLACE FUNCTION public.gympulse_payments_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('gympulse.allow_payment_reset', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Payments cannot be deleted; receipt numbers must stay complete.' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS payments_no_delete ON public.payments;
CREATE TRIGGER payments_no_delete
    BEFORE DELETE ON public.payments
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_payments_no_delete();

-- Empties a disposable demo gym's payments and restarts its receipt numbers. Service role only;
-- the seed script calls it (it refuses to run unless ALLOW_SEED=true).
CREATE OR REPLACE FUNCTION public.gympulse_reset_demo_payments(p_gym_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_gym_id IS NULL THEN
        RAISE EXCEPTION 'Gym is required.' USING ERRCODE = '22004';
    END IF;
    PERFORM set_config('gympulse.allow_payment_reset', 'on', true);
    DELETE FROM public.payments WHERE gym_id = p_gym_id;
    PERFORM set_config('gympulse.allow_payment_reset', '', true);
    DELETE FROM public.gym_receipt_counters WHERE gym_id = p_gym_id;
END;
$$;
REVOKE ALL ON FUNCTION public.gympulse_reset_demo_payments(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gympulse_reset_demo_payments(uuid) TO service_role;
