import { randomBytes } from "node:crypto";
import { supabaseClient } from "../config/database.js";
import { selectCurrentMembership } from "./membershipsService.js";
import { CheckinSettingsError, loadGymCheckin } from "./checkinSettingsService.js";
import { QR_TOKEN_PATTERN, checkInOutcome, checkInStatus, daysLeft, indiaDate } from "../../assets/js/checkin.js";

const attendanceColumns = "id,gym_id,member_id,check_in_date,checked_in_at,method,membership_status_at_check_in,recorded_by,member_device_id,created_at";
const memberCheckinColumns = "id,full_name,member_code,phone,whatsapp_opt_in";
const membershipColumns = "id,gym_id,member_id,plan_id,plan_name,price,total_fees,start_date,end_date,status,created_at";
const PAGE_SIZE = 1000;
const ID_CHUNK = 150;

export class AttendanceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function requireContext(client, gymId) {
    if (!client) throw new AttendanceError(503, "Supabase is not configured.");
    if (!gymId) throw new AttendanceError(403, "Gym is required.");
}

function databaseError(error) {
    if (["PGRST205", "42P01", "PGRST204", "42703"].includes(error?.code)) {
        throw new AttendanceError(503, "Attendance is unavailable. Run migrations 012 and 013 in Supabase SQL Editor.");
    }
    if (error?.code === "23503") throw new AttendanceError(404, "Member not found.");
    throw new AttendanceError(500, "The database could not complete the attendance request.");
}

export async function gymCheckin(gymId, client) {
    try {
        return await loadGymCheckin(gymId, client);
    } catch (error) {
        if (error instanceof CheckinSettingsError) throw new AttendanceError(error.status, error.message);
        throw error;
    }
}

function chunks(list, size = ID_CHUNK) {
    const result = [];
    for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size));
    return result;
}

async function membershipsOf(memberIds, gymId, client) {
    const rows = [];
    for (const ids of chunks(memberIds)) {
        const { data, error } = await client.from("member_memberships").select(membershipColumns).in("member_id", ids).eq("gym_id", gymId);
        if (error) databaseError(error);
        rows.push(...(data || []));
    }
    return rows;
}

// What a renewal costs: the plan's current price while the plan is still offered, otherwise
// what the member paid last time.
async function renewalPrice(membership, gymId, client) {
    if (!membership) return null;
    if (membership.plan_id) {
        const { data } = await client.from("membership_plans").select("id,price,is_active").eq("id", membership.plan_id).eq("gym_id", gymId).maybeSingle();
        if (data?.is_active && Number(data.price) > 0) return Number(data.price);
    }
    return Number(membership.price) > 0 ? Number(membership.price) : null;
}

function describe(member, membership, today) {
    return {
        member: { id: member.id, full_name: member.full_name, member_code: member.member_code, phone: member.phone, whatsapp_opt_in: member.whatsapp_opt_in === true },
        membership: membership ? {
            id: membership.id,
            plan_name: membership.plan_name,
            start_date: membership.start_date,
            end_date: membership.end_date,
            price: membership.price,
            effective_status: membership.effective_status,
            days_left: daysLeft(membership.end_date, today)
        } : null
    };
}

async function todaysCheckIn(memberId, gymId, today, client) {
    const { data, error } = await client
        .from("attendance")
        .select(attendanceColumns)
        .eq("gym_id", gymId)
        .eq("member_id", memberId)
        .eq("check_in_date", today)
        .maybeSingle();
    if (error) databaseError(error);
    return data;
}

/**
 * The one path every check-in takes (member QR, entrance poster, manual). It applies the gym's
 * grace days and expired-member policy, then records today's check-in, or reports the one
 * already recorded. The unique index on (gym, member, IST day) decides, so two check-ins at
 * the same moment cannot both be recorded. Blocked check-ins are not stored.
 */
export async function recordCheckIn(member, method, gym, { userId = null, deviceId = null, client = supabaseClient, now = new Date() } = {}) {
    const gymId = gym.id;
    const today = indiaDate(now);
    const membership = selectCurrentMembership(await membershipsOf([member.id], gymId, client), today);
    const { status, graceDaysLeft } = checkInStatus(membership, today, gym.expiry_grace_days || 0);
    const outcome = checkInOutcome(status, gym.expired_checkin_policy);
    const details = {
        ...describe(member, membership, today),
        status,
        grace_days_left: graceDaysLeft ?? null,
        renewal_price: ["active", "upcoming"].includes(status) ? null : await renewalPrice(membership, gymId, client)
    };
    if (outcome.blocked) {
        const existing = await todaysCheckIn(member.id, gymId, today, client);
        if (existing) return { result: "already_checked_in", recorded: false, blocked: false, attendance: existing, ...details };
        return { result: outcome.result, recorded: false, blocked: true, attendance: null, ...details };
    }
    const { data, error } = await client
        .from("attendance")
        .insert({
            gym_id: gymId,
            member_id: member.id,
            method,
            membership_status_at_check_in: status,
            recorded_by: userId,
            member_device_id: deviceId,
            checked_in_at: now.toISOString()
        })
        .select(attendanceColumns)
        .single();
    if (error?.code === "23505") {
        const existing = await todaysCheckIn(member.id, gymId, today, client);
        return { result: "already_checked_in", recorded: false, blocked: false, attendance: existing, ...details };
    }
    if (error) databaseError(error);
    return { result: outcome.result, recorded: true, blocked: false, attendance: data, ...details };
}

export const METHOD_OFF_MESSAGE = "Member QR cards are switched off for this gym: members check in with the entrance poster. The owner can change this in Settings.";

/**
 * Checks in the member whose QR token this is, in this gym only. An unknown token and a token
 * from another gym get the same "not_found" answer, so nothing about other gyms is revealed.
 * Refused when the gym uses the entrance poster instead.
 */
export async function scanCheckIn(token, gymId, userId = null, client = supabaseClient, now = new Date()) {
    requireContext(client, gymId);
    const gym = await gymCheckin(gymId, client);
    if (gym.checkin_method !== "member_qr") throw new AttendanceError(409, METHOD_OFF_MESSAGE);
    if (!QR_TOKEN_PATTERN.test(String(token || ""))) return { result: "not_found" };
    const { data: member, error } = await client
        .from("members")
        .select(memberCheckinColumns)
        .eq("qr_token", token)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (error) databaseError(error);
    if (!member) return { result: "not_found" };
    return recordCheckIn(member, "member_qr", gym, { userId, client, now });
}

/** Staff check a member in by hand. Works with either method; the gym's policy still applies. */
export async function manualCheckIn(memberId, gymId, userId = null, client = supabaseClient, now = new Date()) {
    requireContext(client, gymId);
    const gym = await gymCheckin(gymId, client);
    const { data: member, error } = await client
        .from("members")
        .select(memberCheckinColumns)
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (error) databaseError(error);
    if (!member) throw new AttendanceError(404, "Member not found.");
    return recordCheckIn(member, "manual", gym, { userId, client, now });
}

// ---------- "Can't scan? Check in manually" ----------

const USUAL_WINDOW_MIN = 60;
const USUAL_LOOKBACK_DAYS = 30;
const USUAL_MIN_VISITS = 2;
const SEARCH_LIMIT = 12;

function minutesOfIndiaDay(date) {
    return Math.floor(((date.getTime() + 330 * 60000) % 86400000) / 60000);
}

function minutesApart(a, b) {
    const gap = Math.abs(a - b);
    return Math.min(gap, 1440 - gap);
}

// A quoted value inside a PostgREST or() filter.
function orPattern(text) {
    return `"%${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}%"`;
}

/**
 * Members for the manual check-in list. Up to 4 digits match the end of the phone number
 * ("3210", typed left to right), more digits match anywhere in it, and text matches the
 * name or member ID. Members who usually check in around this time of day come first; with
 * no search text, only they are listed.
 */
export async function searchCheckInMembers(text, gymId, client = supabaseClient, now = new Date()) {
    requireContext(client, gymId);
    const query = String(text || "").trim();
    const digits = query.replace(/[\s-]/g, "");
    let candidates = null;
    if (query) {
        let request = client.from("members").select("id,full_name,member_code,phone_last4").eq("gym_id", gymId).is("archived_at", null);
        if (/^\d{1,4}$/.test(digits)) request = request.like("phone_last4", `${digits}%`);
        else if (/^\d{5,10}$/.test(digits)) request = request.like("phone_last10", `%${digits}%`);
        else request = request.or(`full_name.ilike.${orPattern(query)},member_code.ilike.${orPattern(query)}`);
        const { data, error } = await request.order("full_name", { ascending: true }).range(0, 49);
        if (error) databaseError(error);
        candidates = data || [];
        if (!candidates.length) return [];
    }

    const since = indiaDate(new Date(now.getTime() - USUAL_LOOKBACK_DAYS * 86400000));
    let visits = client.from("attendance").select("member_id,checked_in_at,check_in_date").eq("gym_id", gymId).gte("check_in_date", since);
    if (candidates) visits = visits.in("member_id", candidates.map((member) => member.id));
    const { data: rows, error } = await visits.order("checked_in_at", { ascending: false }).range(0, 4999);
    if (error) databaseError(error);
    const nowMinutes = minutesOfIndiaDay(now);
    const today = indiaDate(now);
    const usual = new Map();
    const checkedToday = new Set();
    for (const row of rows || []) {
        if (row.check_in_date === today) checkedToday.add(row.member_id);
        else if (minutesApart(minutesOfIndiaDay(new Date(row.checked_in_at)), nowMinutes) <= USUAL_WINDOW_MIN) {
            usual.set(row.member_id, (usual.get(row.member_id) || 0) + 1);
        }
    }

    if (!candidates) {
        const ids = [...usual.entries()].filter(([, count]) => count >= USUAL_MIN_VISITS).map(([id]) => id);
        if (!ids.length) return [];
        const { data, error: membersError } = await client.from("members").select("id,full_name,member_code,phone_last4").eq("gym_id", gymId).is("archived_at", null).in("id", ids.slice(0, 50));
        if (membersError) databaseError(membersError);
        candidates = data || [];
    }
    return candidates
        .map((member) => ({
            id: member.id,
            full_name: member.full_name,
            member_code: member.member_code,
            phone_last4: member.phone_last4 || "",
            usually_now: (usual.get(member.id) || 0) >= USUAL_MIN_VISITS,
            checked_in_today: checkedToday.has(member.id),
            visits_around_now: usual.get(member.id) || 0
        }))
        .sort((a, b) => Number(b.usually_now) - Number(a.usually_now)
            || b.visits_around_now - a.visits_around_now
            || a.full_name.localeCompare(b.full_name))
        .slice(0, SEARCH_LIMIT);
}

async function withMemberNames(rows, gymId, client) {
    const ids = [...new Set(rows.map((row) => row.member_id))];
    const members = new Map();
    for (const part of chunks(ids)) {
        const { data, error } = await client.from("members").select("id,full_name,member_code").in("id", part).eq("gym_id", gymId);
        if (error) databaseError(error);
        for (const member of data || []) members.set(member.id, member);
    }
    return rows.map((row) => ({ ...row, member: members.get(row.member_id) || null }));
}

/** Check-ins for one IST day, or a range of days, newest first. */
export async function listAttendance({ date, from, to }, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
        let query = client.from("attendance").select(attendanceColumns).eq("gym_id", gymId);
        if (date) query = query.eq("check_in_date", date);
        if (from) query = query.gte("check_in_date", from);
        if (to) query = query.lte("check_in_date", to);
        const { data, error } = await query
            .order("checked_in_at", { ascending: false })
            .order("id", { ascending: false })
            .range(offset, offset + PAGE_SIZE - 1);
        if (error) databaseError(error);
        rows.push(...(data || []));
        if (!data || data.length < PAGE_SIZE) break;
    }
    return withMemberNames(rows, gymId, client);
}

async function requireMember(memberId, gymId, client) {
    const { data, error } = await client.from("members").select("id").eq("id", memberId).eq("gym_id", gymId).maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new AttendanceError(404, "Member not found.");
}

export async function listMemberAttendance(memberId, gymId, client = supabaseClient, limit = 60) {
    requireContext(client, gymId);
    await requireMember(memberId, gymId, client);
    const { data, error } = await client
        .from("attendance")
        .select(attendanceColumns)
        .eq("gym_id", gymId)
        .eq("member_id", memberId)
        .order("checked_in_at", { ascending: false })
        .range(0, limit - 1);
    if (error) databaseError(error);
    return data || [];
}

export function newQrToken() {
    return randomBytes(32).toString("base64url");
}

/** Gives the member a new QR token; the old QR stops working at once. */
export async function reissueQrToken(memberId, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client
        .from("members")
        .update({ qr_token: newQrToken(), updated_at: new Date().toISOString() })
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .select("id,qr_token")
        .maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new AttendanceError(404, "Member not found.");
    return data;
}

/**
 * Moves check-ins that were saved only in a browser into the database. Only members of this
 * gym are accepted, one per member per IST day; the membership status is worked out for the
 * day of each visit.
 */
export async function importAttendance(records, gymId, userId = null, client = supabaseClient, now = new Date()) {
    requireContext(client, gymId);
    const memberIds = [...new Set(records.map((record) => record.member_id))];
    const known = new Set();
    for (const part of chunks(memberIds)) {
        const { data, error } = await client.from("members").select("id").in("id", part).eq("gym_id", gymId);
        if (error) databaseError(error);
        for (const member of data || []) known.add(member.id);
    }
    const memberships = await membershipsOf([...known], gymId, client);
    const byMember = new Map();
    for (const row of memberships) byMember.set(row.member_id, [...(byMember.get(row.member_id) || []), row]);

    const perDay = new Map();
    let skipped = 0;
    for (const record of records) {
        const at = new Date(record.checked_in_at);
        if (!known.has(record.member_id) || Number.isNaN(at.getTime()) || at > now) { skipped += 1; continue; }
        const day = indiaDate(at);
        const key = `${record.member_id}:${day}`;
        const current = perDay.get(key);
        if (!current || at < new Date(current.checked_in_at)) {
            const status = checkInStatus(selectCurrentMembership(byMember.get(record.member_id) || [], day), day).status;
            perDay.set(key, { gym_id: gymId, member_id: record.member_id, checked_in_at: at.toISOString(), method: "manual", membership_status_at_check_in: status, recorded_by: userId });
        }
    }
    const rows = [...perDay.values()];
    let imported = 0;
    for (const part of chunks(rows, 500)) {
        const { data, error } = await client
            .from("attendance")
            .upsert(part, { onConflict: "gym_id,member_id,check_in_date", ignoreDuplicates: true })
            .select("id");
        if (error) databaseError(error);
        imported += (data || []).length;
    }
    return { imported, already_recorded: rows.length - imported, skipped: skipped + (records.length - skipped - rows.length) };
}
