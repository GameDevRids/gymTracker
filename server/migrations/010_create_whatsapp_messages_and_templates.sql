-- 010: a durable log of WhatsApp messages sent to members, and per-gym editable message templates.
-- The welcome message is sent through wa.me (click-to-chat), so "sent" means the owner opened
-- WhatsApp with the filled message; it is not a delivery receipt.

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id uuid NOT NULL,
    member_id uuid NOT NULL,
    reminder_type text NOT NULL,
    channel text NOT NULL DEFAULT 'wa_me',
    status text NOT NULL DEFAULT 'sent',
    language text,
    body text,
    -- Kept as a plain id, not a foreign key, so the record survives if that login is removed.
    sent_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT whatsapp_messages_gym_id_fkey
        FOREIGN KEY (gym_id) REFERENCES public.gyms (id) ON DELETE CASCADE,
    CONSTRAINT whatsapp_messages_gym_member_fkey
        FOREIGN KEY (gym_id, member_id) REFERENCES public.members (gym_id, id) ON DELETE RESTRICT,
    CONSTRAINT whatsapp_messages_reminder_type_valid
        CHECK (reminder_type IN ('welcome', 'expiry', 'payment', 'inactive')),
    CONSTRAINT whatsapp_messages_channel_valid CHECK (channel IN ('wa_me', 'cloud_api')),
    CONSTRAINT whatsapp_messages_status_valid
        CHECK (status IN ('sent', 'accepted', 'delivered', 'read', 'failed')),
    CONSTRAINT whatsapp_messages_language_valid CHECK (language IS NULL OR language IN ('en', 'hi', 'mr')),
    CONSTRAINT whatsapp_messages_body_length CHECK (body IS NULL OR char_length(body) <= 4096)
);

CREATE INDEX IF NOT EXISTS whatsapp_messages_gym_member_type_created_idx
    ON public.whatsapp_messages (gym_id, member_id, reminder_type, created_at DESC);

-- A message can only be logged for a current member of the same gym who has WhatsApp consent.
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
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gympulse_whatsapp_message_requires_consent() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_messages_require_consent ON public.whatsapp_messages;
CREATE TRIGGER whatsapp_messages_require_consent
    BEFORE INSERT ON public.whatsapp_messages
    FOR EACH ROW
    EXECUTE FUNCTION public.gympulse_whatsapp_message_requires_consent();

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.whatsapp_messages TO authenticated;
GRANT ALL ON public.whatsapp_messages TO service_role;

DROP POLICY IF EXISTS whatsapp_messages_select_own_gym ON public.whatsapp_messages;
CREATE POLICY whatsapp_messages_select_own_gym ON public.whatsapp_messages
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));

-- One saved body per gym, template and language. A missing row means "use the built-in default".
CREATE TABLE IF NOT EXISTS public.gym_message_templates (
    gym_id uuid NOT NULL REFERENCES public.gyms (id) ON DELETE CASCADE,
    template_key text NOT NULL,
    language text NOT NULL,
    body text NOT NULL,
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (gym_id, template_key, language),
    CONSTRAINT gym_message_templates_key_valid CHECK (template_key IN ('welcome')),
    CONSTRAINT gym_message_templates_language_valid CHECK (language IN ('en', 'hi', 'mr')),
    CONSTRAINT gym_message_templates_body_length CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000)
);

ALTER TABLE public.gym_message_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gym_message_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.gym_message_templates TO authenticated;
GRANT ALL ON public.gym_message_templates TO service_role;

DROP POLICY IF EXISTS gym_message_templates_select_own_gym ON public.gym_message_templates;
CREATE POLICY gym_message_templates_select_own_gym ON public.gym_message_templates
    FOR SELECT TO authenticated USING (public.gympulse_user_has_gym(gym_id));
