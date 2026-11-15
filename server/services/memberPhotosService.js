import { randomBytes } from "node:crypto";
import { supabaseClient } from "../config/database.js";
import { logger } from "../config/logger.js";
import { captureException } from "../config/monitoring.js";
import { preparePhoto } from "./photoFile.js";

// Member photos (migration 014). Files live in the private "member-photos" bucket at
// <gym_id>/<member_id>/<random>.jpg|webp. Only this server touches the bucket (service role);
// viewers get signed URLs that expire after an hour, and only for members of their own gym.
// A photo is never saved unless the member has agreed (members.photo_consent), and photos are
// never put on the welcome card, member card, receipts or anything sent to WhatsApp.

export const PHOTO_BUCKET = "member-photos";
export const SIGNED_URL_SECONDS = 60 * 60;
const PHOTO_CONSENT_SOURCES = new Set(["desk", "poster_page"]);
const photoColumns = "id,gym_id,full_name,member_code,phone_last4,photo_path,photo_status,photo_updated_at,photo_consent,photo_consent_at,photo_device_id,archived_at";

export class MemberPhotoError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function requireContext(client, gymId) {
    if (!client) throw new MemberPhotoError(503, "Supabase is not configured.");
    if (!gymId) throw new MemberPhotoError(403, "Gym is required.");
}

function databaseError(error) {
    if (["PGRST204", "PGRST202", "42703", "42883"].includes(error?.code)) {
        throw new MemberPhotoError(503, "Member photos are unavailable. Run migration 014_add_member_photos.sql in Supabase SQL Editor.");
    }
    if (error?.code === "P0002") throw new MemberPhotoError(404, "Member not found.");
    if (error?.code === "23514") throw new MemberPhotoError(409, "The photo could not be saved. Ask the member to agree first, then try again.");
    throw new MemberPhotoError(500, "The database could not complete the photo request.");
}

function storageError(error, action) {
    logger.error({ err: error, action }, "Member photo storage request failed.");
    captureException(error instanceof Error ? error : new Error(`Member photo storage request failed: ${action}`), { tags: { area: "photos" } });
    throw new MemberPhotoError(503, `The photo could not be ${action} right now. Please try again.`);
}

function bucket(client) {
    return client.storage.from(PHOTO_BUCKET);
}

/** A path inside this member's own folder; the database refuses any other (migration 014). */
export function newPhotoPath(gymId, memberId, extension) {
    return `${gymId}/${memberId}/${randomBytes(24).toString("base64url")}.${extension}`;
}

function inOwnFolder(path, gymId, memberId) {
    return typeof path === "string" && path.startsWith(`${gymId}/${memberId}/`);
}

async function removeFiles(paths, client) {
    const list = paths.filter(Boolean);
    if (!list.length) return;
    const { error } = await bucket(client).remove(list);
    if (error) storageError(error, "deleted");
}

/** Deleting a file that is no longer referenced; a failure is logged, not shown to staff. */
async function removeQuietly(path, client) {
    if (!path) return;
    try {
        const { error } = await bucket(client).remove([path]);
        if (error) throw error;
    } catch (error) {
        logger.warn({ err: error }, "An old member photo could not be deleted; run scripts/sweep-orphan-photos.js.");
    }
}

async function photoMember(memberId, gymId, client) {
    const { data, error } = await client
        .from("members")
        .select(photoColumns)
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new MemberPhotoError(404, "Member not found.");
    return data;
}

/** What the app is told about a member's photo; the storage path itself is never sent. */
export function photoSummary(member) {
    return {
        member_id: member.id,
        status: member.photo_status || "none",
        consent: member.photo_consent === true,
        consent_at: member.photo_consent_at || null,
        updated_at: member.photo_updated_at || null
    };
}

async function callConsent(memberId, gymId, consent, source, recordedBy, client) {
    const { data, error } = await client.rpc("gympulse_set_member_photo_consent", {
        p_gym_id: gymId,
        p_member_id: memberId,
        p_consent: consent,
        p_source: source,
        p_recorded_by: recordedBy
    });
    if (error) databaseError(error);
    const member = Array.isArray(data) ? data[0] : data;
    if (!member?.id) throw new MemberPhotoError(404, "Member not found.");
    return member;
}

/**
 * Records the member's own "I agree" (or a withdrawal). Withdrawing deletes the photo file
 * first, then clears the photo and appends a 'withdrawn' event in one database statement.
 */
export async function setPhotoConsent(memberId, gymId, { agree, source = "desk", recordedBy = null }, client = supabaseClient) {
    requireContext(client, gymId);
    if (typeof agree !== "boolean") throw new MemberPhotoError(400, "Send agree as true or false.");
    if (!PHOTO_CONSENT_SOURCES.has(source)) throw new MemberPhotoError(400, "Unknown consent source.");
    const member = await photoMember(memberId, gymId, client);
    if (!agree && member.photo_path) {
        if (!inOwnFolder(member.photo_path, gymId, memberId)) throw new MemberPhotoError(500, "The photo is stored in an unexpected place.");
        await removeFiles([member.photo_path], client);
    }
    return photoSummary(await callConsent(memberId, gymId, agree, source, recordedBy, client));
}

async function uploadFile(path, photo, client) {
    const { error } = await bucket(client).upload(path, photo.buffer, {
        contentType: photo.contentType,
        cacheControl: String(SIGNED_URL_SECONDS),
        upsert: false
    });
    if (error) storageError(error, "saved");
}

/**
 * Staff add or replace a member's photo (saved as approved). The file is checked by its bytes,
 * the member must have agreed, and the old file is deleted once the new one is in place.
 */
export async function uploadMemberPhoto(memberId, gymId, body, client = supabaseClient) {
    requireContext(client, gymId);
    const photo = preparePhoto(body);
    const member = await photoMember(memberId, gymId, client);
    if (!member.photo_consent) throw new MemberPhotoError(403, "The member has not agreed to a photo yet. Ask them to tap \"I agree\" first.");
    const path = newPhotoPath(gymId, memberId, photo.extension);
    await uploadFile(path, photo, client);
    const now = new Date().toISOString();
    let update = client
        .from("members")
        .update({ photo_path: path, photo_status: "approved", photo_device_id: null, photo_updated_at: now, updated_at: now })
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .eq("photo_consent", true)
        .is("archived_at", null);
    // Only replace the photo this request saw, so two uploads at once cannot both "win".
    update = member.photo_path ? update.eq("photo_path", member.photo_path) : update.is("photo_path", null);
    const { data, error } = await update.select(photoColumns).maybeSingle();
    if (error || !data) {
        await removeQuietly(path, client);
        if (error) databaseError(error);
        throw new MemberPhotoError(409, "The photo changed while saving. Please try again.");
    }
    if (member.photo_path && member.photo_path !== path) await removeQuietly(member.photo_path, client);
    return photoSummary(data);
}

/** Removes the photo (file and columns). Consent stays as it is. */
export async function deleteMemberPhoto(memberId, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const member = await photoMember(memberId, gymId, client);
    if (!member.photo_path) return photoSummary(member);
    await removeFiles([member.photo_path], client);
    const now = new Date().toISOString();
    const { data, error } = await client
        .from("members")
        .update({ photo_path: null, photo_status: "none", photo_device_id: null, photo_updated_at: now, updated_at: now })
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .eq("photo_path", member.photo_path)
        .select(photoColumns)
        .maybeSingle();
    if (error) databaseError(error);
    return photoSummary(data || { ...member, photo_path: null, photo_status: "none" });
}

/** Archiving a member deletes their photo file; the caller clears the columns with the archive. */
export async function removePhotoBeforeArchive(memberId, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client
        .from("members")
        .select("id,photo_path")
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (error) databaseError(error);
    if (data?.photo_path) {
        if (!inOwnFolder(data.photo_path, gymId, memberId)) throw new MemberPhotoError(500, "The photo is stored in an unexpected place.");
        await removeFiles([data.photo_path], client);
    }
    return data?.photo_path || null;
}

/** Staff approve a photo the member sent from the entrance poster page. */
export async function approvePendingPhoto(memberId, gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const now = new Date().toISOString();
    const { data, error } = await client
        .from("members")
        .update({ photo_status: "approved", photo_device_id: null, photo_updated_at: now, updated_at: now })
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .eq("photo_status", "pending")
        .is("archived_at", null)
        .select(photoColumns)
        .maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new MemberPhotoError(404, "This photo was already handled.");
    return photoSummary(data);
}

/**
 * Staff reject a photo sent from the poster page: the file is deleted and the poster-page
 * consent is withdrawn (it came from a phone not yet approved), so the member is asked again
 * in person before any photo is taken at the desk.
 */
export async function rejectPendingPhoto(memberId, gymId, recordedBy = null, client = supabaseClient) {
    requireContext(client, gymId);
    const member = await photoMember(memberId, gymId, client);
    if (member.photo_status !== "pending") throw new MemberPhotoError(404, "This photo was already handled.");
    if (!inOwnFolder(member.photo_path, gymId, memberId)) throw new MemberPhotoError(500, "The photo is stored in an unexpected place.");
    await removeFiles([member.photo_path], client);
    return photoSummary(await callConsent(memberId, gymId, false, "desk", recordedBy, client));
}

/** A rejected phone request also rejects any photo that phone sent. */
export async function rejectPhotosFromDevice(deviceId, gymId, recordedBy = null, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client
        .from("members")
        .select("id")
        .eq("gym_id", gymId)
        .eq("photo_device_id", deviceId)
        .eq("photo_status", "pending");
    if (error) databaseError(error);
    for (const member of data || []) await rejectPendingPhoto(member.id, gymId, recordedBy, client);
    return (data || []).length;
}

// ---------- Viewing: short-lived signed URLs, own gym only ----------

async function signPaths(paths, client) {
    if (!paths.length) return new Map();
    const { data, error } = await bucket(client).createSignedUrls(paths, SIGNED_URL_SECONDS);
    if (error) storageError(error, "loaded");
    return new Map((data || []).filter((item) => item?.signedUrl && !item.error).map((item) => [item.path, item.signedUrl]));
}

/**
 * Signed URLs for members of this gym. Approved photos only, unless staff are reviewing
 * (includePending). Members of other gyms, archived members and members without a photo
 * are simply left out.
 */
export async function signedPhotoUrls(memberIds, gymId, { includePending = false } = {}, client = supabaseClient) {
    requireContext(client, gymId);
    const ids = [...new Set(memberIds)].slice(0, 100);
    if (!ids.length) return {};
    const { data, error } = await client
        .from("members")
        .select("id,gym_id,photo_path,photo_status")
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .in("id", ids);
    if (error) databaseError(error);
    const allowed = new Set(includePending ? ["approved", "pending"] : ["approved"]);
    const rows = (data || []).filter((row) => row.gym_id === gymId && allowed.has(row.photo_status) && inOwnFolder(row.photo_path, gymId, row.id));
    const urls = await signPaths(rows.map((row) => row.photo_path), client);
    const expiresAt = new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString();
    const result = {};
    for (const row of rows) {
        const url = urls.get(row.photo_path);
        if (url) result[row.id] = { status: row.photo_status, url, expires_at: expiresAt };
    }
    return result;
}

/** One member's photo state and, when there is one, a signed URL (pending included, for staff). */
export async function memberPhoto(memberId, gymId, client = supabaseClient) {
    const member = await photoMember(memberId, gymId, client);
    const urls = member.photo_path ? await signedPhotoUrls([memberId], gymId, { includePending: true }, client) : {};
    return { ...photoSummary(member), url: urls[memberId]?.url || null, expires_at: urls[memberId]?.expires_at || null };
}

/** Adds the approved photo (if any) to a staff check-in result. Never fails the check-in. */
export async function withCheckinPhoto(result, gymId, client = supabaseClient) {
    if (!result?.member?.id) return result;
    try {
        const urls = await signedPhotoUrls([result.member.id], gymId, {}, client);
        return { ...result, member: { ...result.member, photo_url: urls[result.member.id]?.url || null } };
    } catch (error) {
        logger.warn({ err: error }, "The check-in photo could not be loaded.");
        return { ...result, member: { ...result.member, photo_url: null } };
    }
}
