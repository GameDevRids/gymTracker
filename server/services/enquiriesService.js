import { supabaseClient } from "../config/database.js";
import { indiaToday } from "./memberStatusService.js";
import { isDue, isOpen, last10, monthStats, tabCounts } from "../../assets/js/enquiries.js";

// Enquiries (migration 024): people who visited and might join. Every read and write is limited to
// the signed-in gym. The same phone can be an open enquiry once per gym (the database enforces it),
// and an enquiry that did not join is deleted 90 days after it last changed (gympulse_purge_old_enquiries,
// run when the list loads and every hour by the server).

export class EnquiryError extends Error {
    /** reason: a short code the app words its message from; extra: e.g. the duplicate's id. */
    constructor(status, message, reason = "", extra = {}) {
        super(message);
        this.status = status;
        this.reason = reason;
        Object.assign(this, extra);
    }
}

const PAGE = 1000;
const MISSING = ["PGRST202", "PGRST204", "PGRST205", "42883", "42P01", "42703"];
export const enquiryColumns = "id,gym_id,full_name,phone,interest_plan_id,interest_text,source,note,stage,follow_up_on,last_contacted_at,whatsapp_consent,whatsapp_consent_at,joined_member_id,created_by,created_at,updated_at";

function databaseError(error) {
    if (MISSING.includes(error?.code)) return new EnquiryError(503, "Enquiries need the latest database update. Run migration 024_add_enquiries.sql in Supabase SQL Editor.", "unavailable");
    if (error?.code === "23505") return new EnquiryError(409, "This phone number already has an open enquiry.", "enquiry_exists");
    if (error?.code === "23503") return new EnquiryError(400, "Choose one of your gym's plans.", "invalid_plan");
    if (error?.code === "23514") return new EnquiryError(400, "Check the name, phone number and the other details.", "invalid");
    return new EnquiryError(500, "The database could not complete the enquiry request.");
}

function requireContext(client, gymId) {
    if (!client) throw new EnquiryError(503, "Supabase is not configured.");
    if (!gymId) throw new EnquiryError(403, "Gym is required.");
}

/** Deletes enquiries that did not join and have not changed for 90 days. gymId null = every gym. Never fails the caller. */
export async function purgeOldEnquiries(gymId = null, client = supabaseClient) {
    if (!client) return 0;
    try {
        const { data, error } = await client.rpc("gympulse_purge_old_enquiries", { p_gym_id: gymId });
        return error ? 0 : Number(data) || 0;
    } catch {
        return 0;
    }
}

async function readAll(client, gymId) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await client.from("enquiries").select(enquiryColumns).eq("gym_id", gymId)
            .order("created_at", { ascending: false }).order("id", { ascending: true }).range(from, from + PAGE - 1);
        if (error) throw databaseError(error);
        rows.push(...(data || []));
        if (!data || data.length < PAGE) return rows;
    }
}

async function withPlanNames(rows, gymId, client) {
    const planIds = [...new Set(rows.map((row) => row.interest_plan_id).filter(Boolean))];
    const names = new Map();
    if (planIds.length) {
        const { data } = await client.from("membership_plans").select("id,name").eq("gym_id", gymId).in("id", planIds);
        for (const plan of data || []) names.set(plan.id, plan.name);
    }
    return rows.map((row) => ({ ...row, interest_plan_name: row.interest_plan_id ? names.get(row.interest_plan_id) || "" : "" }));
}

/**
 * Every enquiry of the gym (the app shows them by tab), the count on each tab, and this month's numbers.
 * Old enquiries are cleaned up first.
 */
export async function listEnquiries(gymId, client = supabaseClient, today = indiaToday()) {
    requireContext(client, gymId);
    await purgeOldEnquiries(gymId, client);
    const enquiries = await withPlanNames(await readAll(client, gymId), gymId, client);
    return { today, enquiries, counts: tabCounts(enquiries, today), stats: monthStats(enquiries, today) };
}

/** How many open enquiries have a follow-up due today or overdue (the sidebar badge and Today). */
export async function dueEnquiryCount(gymId, client = supabaseClient, today = indiaToday()) {
    requireContext(client, gymId);
    const { data, error } = await client.from("enquiries").select("id,stage,follow_up_on").eq("gym_id", gymId).in("stage", ["new", "contacted"]).lte("follow_up_on", today);
    if (error) throw databaseError(error);
    return (data || []).filter((row) => isDue(row, today)).length;
}

async function findEnquiry(id, gymId, client) {
    const { data, error } = await client.from("enquiries").select(enquiryColumns).eq("id", id).eq("gym_id", gymId).maybeSingle();
    if (error) throw databaseError(error);
    if (!data) throw new EnquiryError(404, "Enquiry not found.", "not_found");
    return data;
}

/**
 * Before saving a phone: a current member with it ({ member }), or an open enquiry with it
 * ({ enquiry }); otherwise null. exceptId: the enquiry being edited.
 */
export async function findDuplicate(phone, gymId, client = supabaseClient, exceptId = null) {
    requireContext(client, gymId);
    const digits = last10(phone);
    const { data: members, error: memberError } = await client.from("members").select("id,full_name,member_code")
        .eq("gym_id", gymId).eq("phone_last10", digits).is("archived_at", null).limit(1);
    if (memberError) throw databaseError(memberError);
    if (members?.length) return { member: members[0] };
    const { data: open, error } = await client.from("enquiries").select("id,full_name").eq("gym_id", gymId).eq("phone", phone).in("stage", ["new", "contacted"]);
    if (error) throw databaseError(error);
    const other = (open || []).find((row) => row.id !== exceptId);
    return other ? { enquiry: other } : null;
}

function duplicateError(duplicate) {
    if (duplicate.member) {
        return new EnquiryError(409, `${duplicate.member.full_name || "Someone"} is already a member with this phone number.`, "member_exists", { member_id: duplicate.member.id });
    }
    return new EnquiryError(409, `${duplicate.enquiry.full_name || "Someone"} already has an open enquiry with this phone number.`, "enquiry_exists", { enquiry_id: duplicate.enquiry.id });
}

function consentFields(consent, now) {
    return consent ? { whatsapp_consent: true, whatsapp_consent_at: now.toISOString() } : { whatsapp_consent: false, whatsapp_consent_at: null };
}

/** Saves a new enquiry. input is validated (validateEnquiry.js); the phone is already +91 and 10 digits. */
export async function createEnquiry(input, { gymId, userId = null, now = new Date() }, client = supabaseClient) {
    requireContext(client, gymId);
    const duplicate = await findDuplicate(input.phone, gymId, client);
    if (duplicate) throw duplicateError(duplicate);
    const { consent, ...fields } = input;
    const { data, error } = await client.from("enquiries")
        .insert({ ...fields, ...consentFields(consent === true, now), gym_id: gymId, created_by: userId, stage: "new" })
        .select(enquiryColumns).single();
    if (error) throw databaseError(error);
    return (await withPlanNames([data], gymId, client))[0];
}

/** Changes an enquiry's details, follow-up date, or stage (new / contacted / not interested). */
export async function updateEnquiry(id, changes, { gymId }, client = supabaseClient) {
    requireContext(client, gymId);
    const current = await findEnquiry(id, gymId, client);
    if (current.stage === "joined") throw new EnquiryError(409, "This enquiry has joined; edit the member instead.", "joined");
    if (changes.phone && changes.phone !== current.phone) {
        const duplicate = await findDuplicate(changes.phone, gymId, client, id);
        if (duplicate) throw duplicateError(duplicate);
    }
    const { data, error } = await client.from("enquiries").update(changes).eq("id", id).eq("gym_id", gymId).select(enquiryColumns).single();
    if (error) throw databaseError(error);
    return (await withPlanNames([data], gymId, client))[0];
}

/** The visitor's own answer on the consent step: agree (with the date) or not. */
export async function setEnquiryConsent(id, agree, { gymId, now = new Date() }, client = supabaseClient) {
    requireContext(client, gymId);
    await findEnquiry(id, gymId, client);
    const { data, error } = await client.from("enquiries").update(consentFields(agree, now)).eq("id", id).eq("gym_id", gymId).select(enquiryColumns).single();
    if (error) throw databaseError(error);
    return (await withPlanNames([data], gymId, client))[0];
}

/**
 * WhatsApp was opened for this enquiry: stage Contacted (unless closed) and last_contacted_at now. Only
 * with the visitor's consent. follow_up_on: the next follow-up date, when one was picked.
 */
export async function markContacted(id, { follow_up_on: followUpOn }, { gymId, now = new Date() }, client = supabaseClient) {
    requireContext(client, gymId);
    const current = await findEnquiry(id, gymId, client);
    if (!current.whatsapp_consent) throw new EnquiryError(409, "This visitor has not agreed to WhatsApp messages.", "no_consent");
    if (!isOpen(current)) throw new EnquiryError(409, "This enquiry is closed.", "closed");
    const changes = { stage: "contacted", last_contacted_at: now.toISOString(), ...(followUpOn !== undefined ? { follow_up_on: followUpOn } : {}) };
    const { data, error } = await client.from("enquiries").update(changes).eq("id", id).eq("gym_id", gymId).select(enquiryColumns).single();
    if (error) throw databaseError(error);
    return (await withPlanNames([data], gymId, client))[0];
}

/**
 * The visitor joined: the member they became (saved first, by the member form) is linked and the
 * enquiry is Joined. The member must be in this gym and have the enquiry's phone number.
 */
export async function joinEnquiry(id, memberId, { gymId }, client = supabaseClient) {
    requireContext(client, gymId);
    const current = await findEnquiry(id, gymId, client);
    if (current.stage === "joined") {
        if (current.joined_member_id === memberId) return (await withPlanNames([current], gymId, client))[0];
        throw new EnquiryError(409, "This enquiry has already joined.", "joined");
    }
    const { data: member, error: memberError } = await client.from("members").select("id,phone").eq("id", memberId).eq("gym_id", gymId).is("archived_at", null).maybeSingle();
    if (memberError) throw databaseError(memberError);
    if (!member) throw new EnquiryError(404, "Member not found.", "not_found");
    if (last10(member.phone) !== last10(current.phone)) throw new EnquiryError(409, "The new member's phone number is not the enquiry's.", "phone_mismatch");
    const { data, error } = await client.from("enquiries").update({ stage: "joined", joined_member_id: memberId, follow_up_on: null })
        .eq("id", id).eq("gym_id", gymId).select(enquiryColumns).single();
    if (error) throw databaseError(error);
    return (await withPlanNames([data], gymId, client))[0];
}

/** Removes the enquiry completely. */
export async function deleteEnquiry(id, { gymId }, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client.from("enquiries").delete().eq("id", id).eq("gym_id", gymId).select("id");
    if (error) throw databaseError(error);
    if (!data?.length) throw new EnquiryError(404, "Enquiry not found.", "not_found");
    return { id };
}
