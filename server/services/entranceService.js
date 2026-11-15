import { createHash, randomBytes } from "node:crypto";
import { supabaseClient } from "../config/database.js";
import { recordCheckIn } from "./attendanceService.js";
import { firstName, normalizeIndianMobile, withinRadius } from "../../assets/js/checkin.js";

// The entrance poster: members scan it with their own phone. A phone is linked to a member
// once staff approve it; after that the phone's secret (an HttpOnly cookie) is what checks
// the member in. Only a SHA-256 hash of the secret is stored.

const deviceColumns = "id,gym_id,member_id,device_secret_hash,status,device_label,created_at,approved_at,approved_by,revoked_at,revoked_by,last_used_at";
// A request nobody approved within a week drops off the staff list.
export const PENDING_DAYS = 7;
// Someone who knows a member's number cannot fill the approval list with requests for them.
export const MAX_PENDING_PER_MEMBER = 3;
export const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class EntranceError extends Error {
    constructor(status, message, data = undefined) {
        super(message);
        this.status = status;
        this.data = data;
    }
}

function databaseError(error) {
    if (["PGRST205", "42P01", "PGRST204", "42703"].includes(error?.code)) {
        throw new EntranceError(503, "Check-in is unavailable. Run migration 013_add_checkin_methods_and_member_devices.sql in Supabase SQL Editor.");
    }
    throw new EntranceError(500, "The database could not complete the check-in request.");
}

function requireClient(client) {
    if (!client) throw new EntranceError(503, "Supabase is not configured.");
}

export function newDeviceSecret() {
    return randomBytes(32).toString("base64url");
}

export function hashDeviceSecret(secret) {
    return createHash("sha256").update(String(secret)).digest("hex");
}

/**
 * The 4-digit code shown on the waiting phone and next to the request in the staff list, so
 * staff approve the phone that is in front of them. Derived from the secret, so it is the
 * same after a reload, and every phone gets one whether or not its number is a member's.
 */
export function matchCode(secretHash) {
    return String(parseInt(secretHash.slice(0, 8), 16) % 10000).padStart(4, "0");
}

/** "Android · Chrome" and so on, for the staff list. Nothing else from the User-Agent is kept. */
export function deviceLabel(userAgent = "") {
    const ua = String(userAgent);
    const system = /iPhone|iPad|iPod/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : "Phone";
    const browser = /SamsungBrowser/.test(ua) ? "Samsung Internet" : /EdgA?\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
    return `${system} · ${browser}`;
}

function uniqueFirstNames(rows) {
    const names = rows.map((row) => firstName(row.member.full_name));
    return rows.map((row, index) => {
        const name = names[index];
        if (names.filter((other) => other === name).length < 2) return name;
        const last = String(row.member.full_name).trim().split(/\s+/).slice(1).join(" ");
        return last ? `${name} ${last.charAt(0)}.` : name;
    });
}

// Adds each row's member (this gym only); rows of archived members are dropped.
async function withMembers(rows, gymId, client) {
    const ids = [...new Set(rows.map((row) => row.member_id))];
    if (!ids.length) return [];
    const { data, error } = await client
        .from("members")
        .select("id,full_name,member_code,phone_last4,archived_at")
        .eq("gym_id", gymId)
        .in("id", ids);
    if (error) databaseError(error);
    const members = new Map((data || []).map((member) => [member.id, member]));
    return rows.map((row) => ({ ...row, member: members.get(row.member_id) || null })).filter((row) => row.member && !row.member.archived_at);
}

async function devicesForSecret(gym, secret, client) {
    if (!DEVICE_SECRET_PATTERN.test(String(secret || ""))) return [];
    const { data, error } = await client
        .from("member_devices")
        .select(deviceColumns)
        .eq("gym_id", gym.id)
        .eq("device_secret_hash", hashDeviceSecret(secret));
    if (error) databaseError(error);
    return withMembers(data || [], gym.id, client);
}

function approvedMembers(rows) {
    const approved = rows.filter((row) => row.status === "approved");
    const names = uniqueFirstNames(approved);
    return approved.map((row, index) => ({ ref: row.id, first_name: names[index] }));
}

/**
 * What the poster page shows for this phone: "ready" (approved; one or more first names),
 * "waiting" (a number was entered from this phone), "revoked" or "link" (enter your number).
 * Waiting looks the same whether or not the number belongs to a member.
 * askedAt is when a number was last entered from this phone (ms). A revocation after that wins,
 * so a revoked phone is told so; a number entered after the revocation shows "waiting" again,
 * the same for a member's number and an unknown one.
 */
export async function entranceState(gym, secret, { askedAt = 0 } = {}, client = supabaseClient) {
    requireClient(client);
    const rows = await devicesForSecret(gym, secret, client);
    const members = approvedMembers(rows);
    const base = { gym_name: gym.name, require_location: gym.entrance_require_location === true };
    if (members.length) return { ...base, state: "ready", members };
    const code = secret && DEVICE_SECRET_PATTERN.test(secret) ? matchCode(hashDeviceSecret(secret)) : null;
    const revoked = rows.filter((row) => row.status === "revoked");
    const lastRevokedAt = Math.max(0, ...revoked.map((row) => Date.parse(row.revoked_at) || 0));
    if (askedAt > 0 && code && askedAt > lastRevokedAt) return { ...base, state: "waiting", code };
    if (revoked.length) return { ...base, state: "revoked" };
    return { ...base, state: "link" };
}

/**
 * A member's number was entered on the poster page. For each member of this gym with that
 * number (a family can share one), a pending link for this phone is created. The caller
 * always answers the same way, so the page never reveals whether the number is a member's.
 */
export async function requestLink(gym, secret, phone, { userAgent = "", now = new Date() } = {}, client = supabaseClient) {
    requireClient(client);
    const mobile = normalizeIndianMobile(phone);
    if (!mobile) throw new EntranceError(400, "Enter your 10-digit mobile number.");
    const secretHash = hashDeviceSecret(secret);
    const { data: members, error } = await client
        .from("members")
        .select("id")
        .eq("gym_id", gym.id)
        .eq("phone_last10", mobile)
        .is("archived_at", null);
    if (error) databaseError(error);
    for (const member of members || []) {
        const { data: existing, error: existingError } = await client
            .from("member_devices")
            .select("id,status")
            .eq("gym_id", gym.id)
            .eq("member_id", member.id)
            .eq("device_secret_hash", secretHash)
            .maybeSingle();
        if (existingError) databaseError(existingError);
        if (existing?.status === "approved" || existing?.status === "pending") continue;
        const { data: pending, error: pendingError } = await client
            .from("member_devices")
            .select("id,created_at")
            .eq("gym_id", gym.id)
            .eq("member_id", member.id)
            .eq("status", "pending")
            .order("created_at", { ascending: true });
        if (pendingError) databaseError(pendingError);
        const excess = (pending || []).length - (MAX_PENDING_PER_MEMBER - 1);
        if (excess > 0) {
            const { error: dropError } = await client.from("member_devices").delete().eq("gym_id", gym.id).in("id", pending.slice(0, excess).map((row) => row.id));
            if (dropError) databaseError(dropError);
        }
        const row = { status: "pending", device_label: deviceLabel(userAgent), created_at: now.toISOString(), revoked_at: null, revoked_by: null, approved_at: null, approved_by: null };
        const { error: saveError } = existing
            ? await client.from("member_devices").update(row).eq("id", existing.id).eq("gym_id", gym.id)
            : await client.from("member_devices").insert({ ...row, gym_id: gym.id, member_id: member.id, device_secret_hash: secretHash });
        if (saveError && saveError.code !== "23505") databaseError(saveError);
    }
    return { state: "waiting", code: matchCode(secretHash) };
}

/** The member-facing answer: first name, plan dates and, when a renewal is due, how to pay. */
function memberView(result, gym, upi) {
    const membership = result.membership;
    const renewal = result.renewal_price && ["grace", "expired", "none"].includes(result.status)
        ? { amount: result.renewal_price, upi_id: upi?.upi_id || null, payee_name: upi?.upi_payee_name || gym.name, gym_name: gym.name, plan_name: membership?.plan_name || "" }
        : null;
    return {
        result: result.result,
        recorded: result.recorded,
        blocked: result.blocked,
        status: result.status,
        first_name: firstName(result.member?.full_name),
        checked_in_at: result.attendance?.checked_in_at || null,
        grace_days_left: result.grace_days_left,
        membership: membership ? { plan_name: membership.plan_name, start_date: membership.start_date, end_date: membership.end_date, days_left: membership.days_left } : null,
        renewal
    };
}

/**
 * Checks in from an approved phone. With several members on the phone, `memberRef` (the link
 * id) says who. The location check runs when the gym has it switched on.
 */
export async function entranceCheckIn(gym, secret, { memberRef = null, location = null, now = new Date() } = {}, client = supabaseClient) {
    requireClient(client);
    const rows = (await devicesForSecret(gym, secret, client)).filter((row) => row.status === "approved");
    if (!rows.length) throw new EntranceError(403, "This phone is not linked yet. Ask the front desk to approve it.", { result: "not_linked" });
    let device = rows[0];
    if (rows.length > 1 || memberRef) {
        device = rows.find((row) => row.id === memberRef);
        if (!device) return { result: "choose", members: approvedMembers(rows) };
    }
    if (gym.entrance_require_location) {
        if (!location) return { result: "location_needed" };
        const check = withinRadius(gym, location);
        if (!check.ok) return { result: "too_far", distance_m: check.distance, radius_m: gym.location_radius_m };
    }
    const { data: member, error } = await client
        .from("members")
        .select("id,full_name,member_code,phone,whatsapp_opt_in")
        .eq("id", device.member_id)
        .eq("gym_id", gym.id)
        .is("archived_at", null)
        .maybeSingle();
    if (error) databaseError(error);
    if (!member) throw new EntranceError(403, "This phone is not linked yet. Ask the front desk to approve it.", { result: "not_linked" });
    const result = await recordCheckIn(member, "entrance_poster", gym, { deviceId: device.id, client, now });
    await client.from("member_devices").update({ last_used_at: now.toISOString() }).eq("id", device.id).eq("gym_id", gym.id);
    const needsUpi = result.renewal_price && result.result !== "checked_in";
    const upi = needsUpi ? (await client.from("gym_settings").select("upi_id,upi_payee_name").eq("gym_id", gym.id).maybeSingle()).data : null;
    return memberView(result, gym, upi);
}

// ---------- Staff: approvals and linked phones ----------

function staffDevice(row) {
    return {
        id: row.id,
        member_id: row.member_id,
        member: row.member ? { id: row.member.id, full_name: row.member.full_name, member_code: row.member.member_code, phone_last4: row.member.phone_last4 || "" } : null,
        status: row.status,
        device_label: row.device_label,
        code: matchCode(row.device_secret_hash),
        created_at: row.created_at,
        approved_at: row.approved_at,
        last_used_at: row.last_used_at
    };
}

export async function listPendingDevices(gymId, client = supabaseClient, now = new Date()) {
    requireClient(client);
    const since = new Date(now.getTime() - PENDING_DAYS * 86400000).toISOString();
    const { data, error } = await client
        .from("member_devices")
        .select(deviceColumns)
        .eq("gym_id", gymId)
        .eq("status", "pending")
        .gte("created_at", since)
        .order("created_at", { ascending: false });
    if (error) databaseError(error);
    return (await withMembers(data || [], gymId, client)).map(staffDevice);
}

export async function listMemberDevices(memberId, gymId, client = supabaseClient) {
    requireClient(client);
    const { data, error } = await client
        .from("member_devices")
        .select(deviceColumns)
        .eq("gym_id", gymId)
        .eq("member_id", memberId)
        .in("status", ["approved", "pending"])
        .order("created_at", { ascending: false });
    if (error) databaseError(error);
    return (await withMembers(data || [], gymId, client)).map(staffDevice);
}

async function changeDevice(id, gymId, fromStatus, values, client) {
    requireClient(client);
    const { data, error } = await client
        .from("member_devices")
        .update(values)
        .eq("id", id)
        .eq("gym_id", gymId)
        .eq("status", fromStatus)
        .select(deviceColumns)
        .maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new EntranceError(404, fromStatus === "pending" ? "This request was already handled." : "This phone is not linked.");
    const [withMember] = await withMembers([data], gymId, client);
    return staffDevice(withMember || data);
}

export function approveDevice(id, gymId, userId, client = supabaseClient, now = new Date()) {
    return changeDevice(id, gymId, "pending", { status: "approved", approved_at: now.toISOString(), approved_by: userId }, client);
}

export function revokeDevice(id, gymId, userId, client = supabaseClient, now = new Date()) {
    return changeDevice(id, gymId, "approved", { status: "revoked", revoked_at: now.toISOString(), revoked_by: userId }, client);
}

/** A rejected request is deleted: to the phone it then looks like any unknown number. */
export async function rejectDevice(id, gymId, client = supabaseClient) {
    requireClient(client);
    const { data, error } = await client
        .from("member_devices")
        .delete()
        .eq("id", id)
        .eq("gym_id", gymId)
        .eq("status", "pending")
        .select("id");
    if (error) databaseError(error);
    if (!data?.length) throw new EntranceError(404, "This request was already handled.");
    return { id };
}
