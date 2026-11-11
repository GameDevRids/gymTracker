import { supabaseClient } from "../config/database.js";
import { MembersServiceError } from "./membersService.js";

const messageColumns = "id,gym_id,member_id,reminder_type,channel,status,language,sent_by,created_at";
const templateColumns = "template_key,language,body,updated_at";
const MIGRATION_MESSAGE = "WhatsApp message history is unavailable. Run migration 010_create_whatsapp_messages_and_templates.sql in Supabase SQL Editor.";

function requireContext(client, gymId) {
    if (!client) throw new MembersServiceError(503, "Supabase is not configured.");
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
}

function databaseError(error) {
    if (["PGRST205", "42P01", "PGRST204", "42703"].includes(error?.code)) throw new MembersServiceError(503, MIGRATION_MESSAGE);
    if (error?.code === "23514") throw new MembersServiceError(409, "This member has not agreed to receive WhatsApp messages.");
    if (error?.code === "23503") throw new MembersServiceError(404, "Member not found.");
    throw new MembersServiceError(500, "The database could not complete the WhatsApp message request.");
}

async function findMember(memberId, gymId, client) {
    const { data, error } = await client
        .from("members")
        .select("id,whatsapp_opt_in")
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new MembersServiceError(404, "Member not found.");
    return data;
}

/** WhatsApp messages logged for one member of this gym, newest first. */
export async function listMemberMessages(memberId, { reminderType } = {}, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    await findMember(memberId, gymId, client);
    let query = client
        .from("whatsapp_messages")
        .select(messageColumns)
        .eq("gym_id", gymId)
        .eq("member_id", memberId);
    if (reminderType) query = query.eq("reminder_type", reminderType);
    const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: false });
    if (error) databaseError(error);
    return data || [];
}

/**
 * Logs a message sent to a member. Refused unless the member belongs to this gym and has
 * WhatsApp consent; the database trigger enforces the same rule.
 */
export async function recordMemberMessage(memberId, { reminderType, channel = "wa_me", status = "sent", language = null, body = null, sentBy = null }, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const member = await findMember(memberId, gymId, client);
    if (member.whatsapp_opt_in !== true) {
        throw new MembersServiceError(409, "This member has not agreed to receive WhatsApp messages.");
    }
    const { data, error } = await client
        .from("whatsapp_messages")
        .insert({ gym_id: gymId, member_id: memberId, reminder_type: reminderType, channel, status, language, body, sent_by: sentBy })
        .select(messageColumns)
        .single();
    if (error) databaseError(error);
    return data;
}

/** The templates this gym has saved for a key; languages without a row use the default. */
export async function listTemplates(templateKey, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client
        .from("gym_message_templates")
        .select(templateColumns)
        .eq("gym_id", gymId)
        .eq("template_key", templateKey)
        .order("language", { ascending: true });
    if (error) databaseError(error);
    return data || [];
}

export async function saveTemplate(templateKey, language, body, updatedBy, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client
        .from("gym_message_templates")
        .upsert({ gym_id: gymId, template_key: templateKey, language, body, updated_by: updatedBy, updated_at: new Date().toISOString() }, { onConflict: "gym_id,template_key,language" })
        .select(templateColumns)
        .single();
    if (error) databaseError(error);
    return data;
}

/** Removes the saved body so the built-in default is used again. */
export async function resetTemplate(templateKey, language, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const { error } = await client
        .from("gym_message_templates")
        .delete()
        .eq("gym_id", gymId)
        .eq("template_key", templateKey)
        .eq("language", language);
    if (error) databaseError(error);
}
