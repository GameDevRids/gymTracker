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
export async function recordMemberMessage(memberId, { reminderType, channel = "wa_me", status = "sent", language = null, body = null, sentBy = null, membershipId = null }, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const member = await findMember(memberId, gymId, client);
    if (member.whatsapp_opt_in !== true) {
        throw new MembersServiceError(409, "This member has not agreed to receive WhatsApp messages.");
    }
    // An expiry reminder is tied to the membership and the end date it reminded about, read
    // here rather than taken from the browser, so renewing starts the member unreminded.
    const link = membershipId ? await membershipLink(membershipId, memberId, gymId, client) : {};
    const { data, error } = await client
        .from("whatsapp_messages")
        .insert({ gym_id: gymId, member_id: memberId, reminder_type: reminderType, channel, status, language, body, sent_by: sentBy, ...link })
        .select(membershipId ? `${messageColumns},membership_id,membership_end_date` : messageColumns)
        .single();
    if (error) membershipId ? reminderDatabaseError(error) : databaseError(error);
    return data;
}

const REMINDER_MIGRATION_MESSAGE = "Expiry reminders are unavailable. Run migration 015_move_browser_data_to_database.sql in Supabase SQL Editor.";

function reminderDatabaseError(error) {
    if (["PGRST204", "42703"].includes(error?.code)) throw new MembersServiceError(503, REMINDER_MIGRATION_MESSAGE);
    databaseError(error);
}

async function membershipLink(membershipId, memberId, gymId, client) {
    const { data, error } = await client
        .from("member_memberships")
        .select("id,end_date")
        .eq("id", membershipId)
        .eq("gym_id", gymId)
        .eq("member_id", memberId)
        .maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new MembersServiceError(404, "Membership not found for this member.");
    return { membership_id: data.id, membership_end_date: data.end_date };
}

/**
 * When each membership's current end date was last reminded about, as a Map of
 * membership id -> ISO time. A missing migration 015 only means nothing is marked yet.
 */
export async function expiryRemindersFor(memberships, gymId, client = supabaseClient) {
    const reminded = new Map();
    const ids = [...new Set(memberships.map((membership) => membership.id))];
    if (!ids.length) return reminded;
    const endDates = new Map(memberships.map((membership) => [membership.id, membership.end_date]));
    for (let index = 0; index < ids.length; index += 200) {
        const { data, error } = await client
            .from("whatsapp_messages")
            .select("membership_id,membership_end_date,created_at")
            .eq("gym_id", gymId)
            .eq("reminder_type", "expiry")
            .in("membership_id", ids.slice(index, index + 200));
        if (error) {
            if (["PGRST204", "42703"].includes(error.code)) return reminded;
            databaseError(error);
        }
        for (const row of data || []) {
            if (endDates.get(row.membership_id) !== row.membership_end_date) continue;
            const previous = reminded.get(row.membership_id);
            if (!previous || row.created_at > previous) reminded.set(row.membership_id, row.created_at);
        }
    }
    return reminded;
}

/**
 * Moves "Reminded" marks an older version kept in one browser: { membership_id, end_date, sent_at }.
 * Only marks for this gym's memberships that still end on that date, for members who have
 * WhatsApp consent, and that are not already recorded, are added. Returns { moved, skipped }.
 */
export async function importExpiryReminders(marks, sentBy, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    if (!marks.length) return { moved: 0, skipped: 0 };
    const ids = [...new Set(marks.map((mark) => mark.membership_id))];
    const memberships = [];
    for (let index = 0; index < ids.length; index += 200) {
        const { data, error } = await client
            .from("member_memberships")
            .select("id,member_id,end_date,members!member_memberships_member_id_fkey!inner(id,whatsapp_opt_in,archived_at)")
            .eq("gym_id", gymId)
            .eq("members.gym_id", gymId)
            .in("id", ids.slice(index, index + 200));
        if (error) databaseError(error);
        memberships.push(...(data || []));
    }
    const byId = new Map(memberships.map((membership) => [membership.id, membership]));
    const already = await expiryRemindersFor(memberships, gymId, client);
    const seen = new Set();
    const rows = [];
    for (const mark of marks) {
        const membership = byId.get(mark.membership_id);
        const key = `${mark.membership_id}:${mark.end_date}`;
        if (!membership || membership.end_date !== mark.end_date || seen.has(key) || already.has(mark.membership_id)
            || membership.members?.whatsapp_opt_in !== true || membership.members?.archived_at) continue;
        seen.add(key);
        rows.push({
            gym_id: gymId,
            member_id: membership.member_id,
            reminder_type: "expiry",
            channel: "wa_me",
            status: "sent",
            membership_id: membership.id,
            membership_end_date: membership.end_date,
            sent_by: sentBy,
            created_at: mark.sent_at
        });
    }
    if (rows.length) {
        const { error } = await client.from("whatsapp_messages").insert(rows);
        if (error) reminderDatabaseError(error);
    }
    return { moved: rows.length, skipped: marks.length - rows.length };
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

/** Saves the body only when this gym has no saved body for that template and language yet. */
export async function saveTemplateIfUnset(templateKey, language, body, updatedBy, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const { data: existing, error } = await client
        .from("gym_message_templates")
        .select("template_key")
        .eq("gym_id", gymId)
        .eq("template_key", templateKey)
        .eq("language", language)
        .maybeSingle();
    if (error) databaseError(error);
    if (existing) return false;
    const { error: insertError } = await client
        .from("gym_message_templates")
        .insert({ gym_id: gymId, template_key: templateKey, language, body, updated_by: updatedBy, updated_at: new Date().toISOString() });
    if (insertError) {
        if (insertError.code === "23514") throw new MembersServiceError(503, REMINDER_MIGRATION_MESSAGE);
        databaseError(insertError);
    }
    return true;
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
