import { randomBytes } from "node:crypto";
import { supabaseClient } from "../config/database.js";
import { selectCurrentMembership } from "./membershipsService.js";
import { QR_TOKEN_PATTERN, daysLeft, indiaDate } from "../../assets/js/checkin.js";

const attendanceColumns = "id,gym_id,member_id,check_in_date,checked_in_at,method,membership_status_at_check_in,recorded_by,created_at";
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
        throw new AttendanceError(503, "Attendance is unavailable. Run migration 012_add_qr_checkin_attendance.sql in Supabase SQL Editor.");
    }
    if (error?.code === "23503") throw new AttendanceError(404, "Member not found.");
    throw new AttendanceError(500, "The database could not complete the attendance request.");
}

function chunks(list, size = ID_CHUNK) {
    const result = [];
    for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size));
    return result;
}

/** active, expired or none (no plan, not started yet, or cancelled). */
export function checkInStatus(membership) {
    if (!membership) return "none";
    if (membership.effective_status === "active") return "active";
    if (membership.effective_status === "expired") return "expired";
    return "none";
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

const resultFor = { active: "checked_in", expired: "expired", none: "no_membership" };

// Records today's check-in, or reports the one already recorded. The unique index on
// (gym, member, IST day) decides, so two scanners at once cannot both record it.
async function recordCheckIn(member, method, gymId, userId, client, now) {
    const today = indiaDate(now);
    const membership = selectCurrentMembership(await membershipsOf([member.id], gymId, client), today);
    const status = checkInStatus(membership);
    const details = describe(member, membership, today);
    const { data, error } = await client
        .from("attendance")
        .insert({ gym_id: gymId, member_id: member.id, method, membership_status_at_check_in: status, recorded_by: userId, checked_in_at: now.toISOString() })
        .select(attendanceColumns)
        .single();
    if (error?.code === "23505") {
        const existing = await client
            .from("attendance")
            .select(attendanceColumns)
            .eq("gym_id", gymId)
            .eq("member_id", member.id)
            .eq("check_in_date", today)
            .maybeSingle();
        if (existing.error) databaseError(existing.error);
        return { result: "already_checked_in", status, attendance: existing.data, ...details };
    }
    if (error) databaseError(error);
    return { result: resultFor[status], status, attendance: data, ...details };
}

/**
 * Checks in the member whose QR token this is, in this gym only. An unknown token and a token
 * from another gym get the same "not_found" answer, so nothing about other gyms is revealed.
 */
export async function scanCheckIn(token, gymId, userId = null, client = supabaseClient, now = new Date()) {
    requireContext(client, gymId);
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
    return recordCheckIn(member, "qr", gymId, userId, client, now);
}

export async function manualCheckIn(memberId, gymId, userId = null, client = supabaseClient, now = new Date()) {
    requireContext(client, gymId);
    const { data: member, error } = await client
        .from("members")
        .select(memberCheckinColumns)
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (error) databaseError(error);
    if (!member) throw new AttendanceError(404, "Member not found.");
    return recordCheckIn(member, "manual", gymId, userId, client, now);
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
            const status = checkInStatus(selectCurrentMembership(byMember.get(record.member_id) || [], day));
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
