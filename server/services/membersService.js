import { randomUUID } from "node:crypto";
import { supabaseClient } from "../config/database.js";
import { selectCurrentMembership } from "./membershipsService.js";
import { gymStatusRules, indiaToday } from "./memberStatusService.js";
import { DEFAULT_LAPSED_LIST_DAYS, memberStatusFor } from "../../assets/js/memberStatus.js";
import { removePhotoBeforeArchive } from "./memberPhotosService.js";

const memberColumns = [
    "id",
    "gym_id",
    "member_code",
    "full_name",
    "phone",
    "email",
    "gender",
    "date_of_birth",
    "membership_start_date",
    "membership_end_date",
    "status",
    "notes",
    "emergency_contact",
    "follow_up_status",
    "whatsapp_opt_in",
    "whatsapp_opt_in_at",
    "whatsapp_opt_out_at",
    // Photo state only (migration 014); the storage path never leaves the server.
    "photo_status",
    "photo_updated_at",
    "photo_consent",
    "photo_consent_at",
    "created_at",
    "updated_at",
    "archived_at"
].join(",");

// The check-in QR token is sent only for a single member (profile, new member), never in lists.
const singleMemberColumns = `${memberColumns},qr_token`;

export class MembersServiceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// The unique index from migration 015: one current member per phone number in a gym.
const isPhoneConflict = (error) => error?.code === "23505" && /members_gym_phone_key/.test(`${error.message || ""} ${error.details || ""}`);

function throwDatabaseError(error, operation) {
    if (operation === "payments" && ["PGRST205", "42P01", "42703"].includes(error?.code)) {
        throw new MembersServiceError(503, "Payments are unavailable. Run migration 006_create_payments.sql in Supabase SQL Editor.");
    }
    if (isPhoneConflict(error)) {
        throw new MembersServiceError(409, "This phone number already belongs to another member.");
    }
    if (error?.code === "23505") {
        throw new MembersServiceError(409, "Member code already exists.");
    }
    if (operation === "create" && error?.code === "23502") {
        throw new MembersServiceError(503, "Member creation requires nullable membership dates. Review and apply migration 004_create_member_memberships.sql in Supabase SQL Editor.");
    }
    if (operation === "delete" && error?.code === "23503") {
        throw new MembersServiceError(409, "Member has related records and cannot be deleted.");
    }
    if (error?.code === "PGRST204" || error?.code === "42703") {
        throw new MembersServiceError(503, "The members table is missing required columns. Run the latest migrations (up to 014_add_member_photos.sql) in Supabase SQL Editor.");
    }
    if (error?.code === "PGRST205" || error?.code === "42P01") {
        throw new MembersServiceError(503, "Membership history is unavailable. Run migration 004_create_member_memberships.sql in Supabase SQL Editor.");
    }
    if (error?.code === "42501") {
        throw new MembersServiceError(503, "Supabase denied access to membership history. Check backend service-role access to member_memberships.");
    }
    throw new MembersServiceError(500, "The database could not complete the member request.");
}

function createMemberCode() {
    return `GP-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

function requireSupabaseClient(client = supabaseClient) {
    if (!client) {
        throw new MembersServiceError(503, "Supabase is not configured.");
    }
}

function withoutMembershipDates(member) {
    const {
        membership_start_date: _membershipStartDate,
        membership_end_date: _membershipEndDate,
        ...editableMember
    } = member;
    return editableMember;
}

const currentMembershipColumns = "id,gym_id,member_id,plan_id,plan_name,duration_days,price,total_fees,grace_days,start_date,end_date,status,created_at,updated_at";

// PostgREST returns at most 1000 rows per request, so read in pages until a short page arrives.
const READ_PAGE_SIZE = 1000;

async function readAllRows(buildQuery, operation) {
    const rows = [];
    for (let from = 0; ; from += READ_PAGE_SIZE) {
        const { data, error } = await buildQuery().range(from, from + READ_PAGE_SIZE - 1);
        if (error) throwDatabaseError(error, operation);
        rows.push(...(data || []));
        if (!data || data.length < READ_PAGE_SIZE) return rows;
    }
}

function toMoney(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

// Billed = fees of every non-cancelled membership; paid = every recorded payment. Both come from the database.
export function memberBilling(memberships, payments) {
    const billed = toMoney(memberships
        .filter((membership) => membership.status !== "cancelled")
        .reduce((sum, membership) => sum + Number(membership.total_fees ?? membership.price ?? 0), 0));
    const paid = toMoney(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
    return { billed, paid, outstanding: Math.max(0, toMoney(billed - paid)) };
}

async function addCurrentMemberships(members, gymId, client) {
    if (!members.length) return members;
    const memberIds = members.map((member) => member.id);
    const today = indiaToday();
    const [rules, data, payments] = await Promise.all([
        // The members list never fails over a status detail: default rules if the gym's can't be read.
        gymStatusRules(gymId, client).catch(() => ({ lapsedListDays: DEFAULT_LAPSED_LIST_DAYS, defaultGraceDays: 0 })),
        readAllRows(() => client
            .from("member_memberships")
            .select(currentMembershipColumns)
            .in("member_id", memberIds)
            .eq("gym_id", gymId)
            .order("created_at", { ascending: false })
            .order("start_date", { ascending: false })
            .order("id", { ascending: false }), "membership-history"),
        readAllRows(() => client
            .from("payments")
            .select("id,member_id,amount")
            .in("member_id", memberIds)
            .eq("gym_id", gymId)
            .order("id", { ascending: true }), "payments")
    ]);

    const paymentsByMember = new Map();
    for (const payment of payments) {
        const list = paymentsByMember.get(payment.member_id) || [];
        list.push(payment);
        paymentsByMember.set(payment.member_id, list);
    }

    const membershipsByMember = new Map();
    for (const membership of data) {
        const history = membershipsByMember.get(membership.member_id) || [];
        history.push(membership);
        membershipsByMember.set(membership.member_id, history);
    }

    return members.map((member) => {
        const history = membershipsByMember.get(member.id) || [];
        const currentMembership = selectCurrentMembership(history);
        const state = memberStatusFor(history, today, rules);
        return {
            ...member,
            current_membership: currentMembership,
            membership_status: currentMembership?.effective_status || "unassigned",
            // The shared status (active, expiring, upcoming, in_grace, lapsed, old, none) and its dates.
            member_status: state.status,
            status_detail: { days_left: state.daysLeft, ended_on: state.endedOn || null, grace_until: state.graceUntil || null, grace_days_left: state.graceDaysLeft, next_start: state.nextStart || null },
            billing: memberBilling(history, paymentsByMember.get(member.id) || [])
        };
    });
}

export async function listMembers({ page, limit, status, search, includeArchived = false, gymId }, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    const from = (page - 1) * limit;
    let query = client
        .from("members")
        .select(memberColumns, { count: "exact" })
        .eq("gym_id", gymId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + limit - 1);

    if (!includeArchived) query = query.is("archived_at", null);
    if (status) query = query.eq("status", status);
    if (search) {
        const escaped = search.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        const pattern = `"%${escaped}%"`;
        query = query.or(`full_name.ilike.${pattern},phone.ilike.${pattern},member_code.ilike.${pattern}`);
    }

    const { data, count, error } = await query;
    if (error) throwDatabaseError(error, "list");
    return { members: await addCurrentMemberships(data || [], gymId, client), total: count ?? 0 };
}

export async function getMember(id, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    const { data, error } = await client
        .from("members")
        .select(singleMemberColumns)
        .eq("id", id)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (error) throwDatabaseError(error, "get");
    if (!data) throw new MembersServiceError(404, "Member not found.");
    return (await addCurrentMemberships([data], gymId, client))[0];
}

export async function createMember(member, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    const editableMember = withoutMembershipDates(member);
    const createdAt = new Date().toISOString();
    const hasSuppliedCode = Boolean(editableMember.member_code);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const record = {
            ...editableMember,
            member_code: editableMember.member_code || createMemberCode(),
            gym_id: gymId,
            status: member.status || "active",
            created_at: createdAt,
            updated_at: createdAt
        };
        const { data, error } = await client
            .from("members")
            .insert(record)
            .select(singleMemberColumns)
            .single();

        if (!error) return data;
        if (error.code === "23505" && !isPhoneConflict(error) && !hasSuppliedCode && attempt < 2) continue;
        throwDatabaseError(error, "create");
    }
    throw new MembersServiceError(500, "Could not generate a unique member code.");
}

export async function updateMember(id, member, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    const editableMember = withoutMembershipDates(member);
    if (Object.keys(editableMember).length === 0) {
        throw new MembersServiceError(400, "Provide at least one member field to update.");
    }
    const { data, error } = await client
        .from("members")
        .update({ ...editableMember, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .select(memberColumns)
        .maybeSingle();
    if (error) throwDatabaseError(error, "update");
    if (!data) throw new MembersServiceError(404, "Member not found.");
    return data;
}

/**
 * Refuses a phone number another current member of this gym already has. The browser used to be
 * the only check, and only against the members it had loaded. Migration 015's unique index is
 * the final guard; this gives the owner the other member's name.
 */
export async function assertPhoneAvailable(phone, gymId, { exceptId = null } = {}, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!phone) return;
    const digits = String(phone).replace(/\D/g, "").slice(-10);
    let query = client
        .from("members")
        .select("id,full_name")
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .in("phone", [digits, `+91${digits}`, `91${digits}`])
        .limit(1);
    if (exceptId) query = query.neq("id", exceptId);
    const { data, error } = await query;
    if (error) throwDatabaseError(error, "get");
    if (data?.length) throw new MembersServiceError(409, `This phone number already belongs to ${data[0].full_name}.`);
}

const CONSENT_SOURCES = new Set(["staff_form", "csv_import", "member_reply_stop"]);
const consentEventColumns = "id,gym_id,member_id,channel,action,source,recorded_by,created_at";

function consentDatabaseError(error) {
    if (error?.code === "P0002") throw new MembersServiceError(404, "Member not found.");
    if (["PGRST202", "PGRST205", "42883", "42P01"].includes(error?.code)) {
        throw new MembersServiceError(503, "WhatsApp consent is unavailable. Run migration 009_add_member_contact_and_whatsapp_consent.sql in Supabase SQL Editor.");
    }
    if (error?.code === "22023") throw new MembersServiceError(400, "Unknown consent source.");
    throw new MembersServiceError(500, "The database could not record WhatsApp consent.");
}

/**
 * Grants or withdraws WhatsApp consent. The database function updates the member and appends
 * one history event in the same transaction; repeating the current choice changes nothing.
 */
export async function setWhatsAppConsent(memberId, { optIn, source, recordedBy = null }, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    if (typeof optIn !== "boolean") throw new MembersServiceError(400, "Choose whether the member consents.");
    if (!CONSENT_SOURCES.has(source)) throw new MembersServiceError(400, "Unknown consent source.");
    const { data, error } = await client.rpc("gympulse_set_member_whatsapp_consent", {
        p_gym_id: gymId,
        p_member_id: memberId,
        p_opt_in: optIn,
        p_source: source,
        p_recorded_by: recordedBy
    });
    if (error) consentDatabaseError(error);
    const member = Array.isArray(data) ? data[0] : data;
    if (!member?.id) throw new MembersServiceError(404, "Member not found.");
    return (await addCurrentMemberships([member], gymId, client))[0];
}

/** Consent history for one member of this gym, newest first. */
export async function listConsentEvents(memberId, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    const { data: member, error: memberError } = await client
        .from("members")
        .select("id")
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .maybeSingle();
    if (memberError) throwDatabaseError(memberError, "get");
    if (!member) throw new MembersServiceError(404, "Member not found.");
    const { data, error } = await client
        .from("member_consent_events")
        .select(consentEventColumns)
        .eq("gym_id", gymId)
        .eq("member_id", memberId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
    if (error) consentDatabaseError(error);
    return data || [];
}

export async function deleteMember(id, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    // The photo file is deleted first; the archive then clears the photo columns with it.
    // If the file cannot be deleted, the member is not archived and staff can try again.
    const photoPath = await removePhotoBeforeArchive(id, gymId, client);
    const archivedAt = new Date().toISOString();
    const photoCleared = photoPath ? { photo_path: null, photo_status: "none", photo_device_id: null, photo_updated_at: archivedAt } : {};
    const { data, error } = await client
        .from("members")
        .update({ archived_at: archivedAt, updated_at: archivedAt, ...photoCleared })
        .eq("id", id)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .select("id")
        .maybeSingle();
    if (error) throwDatabaseError(error, "delete");
    if (!data) throw new MembersServiceError(404, "Member not found.");
}
