import { supabaseClient } from "../config/database.js";
import { purgeOldEnquiries } from "./enquiriesService.js";
import { logger } from "../config/logger.js";
import { captureException } from "../config/monitoring.js";
import { GYM_DELETION_GRACE_DAYS, TERMS_VERSION } from "../../assets/js/legal.js";
import { isDemoGym, verifyPassword } from "./authService.js";

// The owner's account (migration 017): agreeing to the Terms, asking for the gym to be deleted
// (locked for 7 days, then erased) or cancelling that, and the sweep that erases gyms when due.

export class AccountError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const PHOTO_BUCKET = "member-photos";
const MISSING = ["PGRST202", "PGRST204", "PGRST205", "42P01", "42703", "42883"];

function databaseError(error, action) {
    if (MISSING.includes(error?.code)) {
        return new AccountError(503, "This needs the latest database update. Run migration 017_add_terms_and_gym_deletion.sql in Supabase SQL Editor.");
    }
    logger.error({ err: error, action }, "Account request failed.");
    return new AccountError(500, "The request could not be completed. Please try again.");
}

function requireClient(client) {
    if (!client) throw new AccountError(503, "Supabase is not configured.");
}

/** The support WhatsApp number from SUPPORT_WHATSAPP_NUMBER as 91XXXXXXXXXX, or "" if not set. */
export function supportWhatsApp(environment = process.env) {
    const value = String(environment.SUPPORT_WHATSAPP_NUMBER || "").trim();
    if (!value) return "";
    // Accepts "98765 43210", "+91-98765-43210", "919876543210" or "09876543210".
    const digits = value.replace(/[\s-]/g, "").replace(/^\+/, "");
    const phone = /^91[6-9]\d{9}$/.test(digits) ? digits.slice(2) : /^0[6-9]\d{9}$/.test(digits) ? digits.slice(1) : digits;
    return /^[6-9]\d{9}$/.test(phone) ? `91${phone}` : "";
}

/** The deletion fields of a gym row, as the app sees them. */
export function deletionState(gym) {
    if (!gym?.deletion_scheduled_for) return null;
    return { requested_at: gym.deletion_requested_at, scheduled_for: gym.deletion_scheduled_for };
}

/** What the app needs after sign-in: Terms, the gym's deletion state, and the support link. */
export async function getAccountStatus({ userId, gymId }, client = supabaseClient) {
    requireClient(client);
    const { data: accepted, error } = await client
        .from("terms_acceptances")
        .select("terms_version,accepted_at")
        .eq("user_id", userId)
        .eq("terms_version", TERMS_VERSION)
        .maybeSingle();
    if (error) throw databaseError(error, "terms");
    let deletion = null;
    if (gymId) {
        const { data: gym, error: gymError } = await client
            .from("gyms")
            .select("deletion_requested_at,deletion_scheduled_for")
            .eq("id", gymId)
            .maybeSingle();
        if (gymError) throw databaseError(gymError, "status");
        deletion = deletionState(gym);
    }
    return {
        terms: { version: TERMS_VERSION, accepted_at: accepted?.accepted_at || null },
        deletion,
        support_whatsapp: supportWhatsApp()
    };
}

/** Records that the user agreed to this version. Agreeing twice is fine. */
export async function acceptTerms(userId, version, client = supabaseClient) {
    requireClient(client);
    if (version !== TERMS_VERSION) {
        throw new AccountError(409, "The Terms have changed since this page was opened. Reload the page and read them again.");
    }
    const { error } = await client.from("terms_acceptances").insert({ user_id: userId, terms_version: version });
    if (error && error.code !== "23505") throw databaseError(error, "accept terms");
    return { version };
}

/**
 * Locks the gym and schedules it to be erased in 7 days. The owner confirms with the gym's
 * name and their password, so a phone left signed in cannot delete the gym.
 */
export async function requestGymDeletion({ gymId, gymName, userId, email, confirmName, password }, client = supabaseClient) {
    requireClient(client);
    if (isDemoGym(gymId)) throw new AccountError(403, "The demo gym cannot be deleted.");
    if (String(confirmName || "").trim().toLowerCase() !== String(gymName || "").trim().toLowerCase()) {
        throw new AccountError(400, "Type the gym's name exactly as it is shown to confirm.");
    }
    await verifyPassword(email, password);
    const now = new Date();
    const scheduled = new Date(now.getTime() + GYM_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const { data, error } = await client
        .from("gyms")
        .update({ deletion_requested_at: now.toISOString(), deletion_scheduled_for: scheduled.toISOString(), deletion_requested_by: userId })
        .eq("id", gymId)
        .is("deletion_scheduled_for", null)
        .select("deletion_requested_at,deletion_scheduled_for");
    if (error) throw databaseError(error, "request deletion");
    if (!data?.length) {
        // Already scheduled (another tap, or another device): report the existing date.
        const status = await getAccountStatus({ userId, gymId }, client);
        if (status.deletion) return status.deletion;
        throw new AccountError(404, "Gym not found.");
    }
    logger.info({ action: "gym deletion requested", scheduledFor: scheduled.toISOString() }, "Gym deletion requested.");
    return deletionState(data[0]);
}

/** Cancels a pending deletion; the gym works again at once. */
export async function cancelGymDeletion(gymId, client = supabaseClient) {
    requireClient(client);
    const { data, error } = await client
        .from("gyms")
        .update({ deletion_requested_at: null, deletion_scheduled_for: null, deletion_requested_by: null })
        .eq("id", gymId)
        .gt("deletion_scheduled_for", new Date().toISOString())
        .select("id");
    if (error) throw databaseError(error, "cancel deletion");
    if (!data?.length) throw new AccountError(409, "This gym has no deletion to cancel, or it is already being erased.");
    logger.info({ action: "gym deletion cancelled" }, "Gym deletion cancelled.");
}

async function listFolder(storage, prefix) {
    const entries = [];
    for (let offset = 0; ; offset += 1000) {
        const { data, error } = await storage.list(prefix, { limit: 1000, offset });
        if (error) throw Object.assign(new Error("Member photos could not be listed."), { cause: error });
        entries.push(...(data || []));
        if (!data || data.length < 1000) return entries;
    }
}

/** Removes every file under <gymId>/ in the photo bucket (one folder per member). */
export async function removeGymPhotos(gymId, client = supabaseClient) {
    const storage = client.storage.from(PHOTO_BUCKET);
    let removed = 0;
    for (const folder of await listFolder(storage, gymId)) {
        // Folders have no id; files directly under the gym folder would be unexpected but go too.
        const paths = folder.id
            ? [`${gymId}/${folder.name}`]
            : (await listFolder(storage, `${gymId}/${folder.name}`)).filter((file) => file.id).map((file) => `${gymId}/${folder.name}/${file.name}`);
        for (let index = 0; index < paths.length; index += 100) {
            const { error } = await storage.remove(paths.slice(index, index + 100));
            if (error) throw Object.assign(new Error("Member photos could not be deleted."), { cause: error });
            removed += Math.min(100, paths.length - index);
        }
    }
    return removed;
}

/**
 * Erases one gym that is due: photos first (so a failure leaves the database rows, and the next
 * sweep tries again), then every row in one transaction, then sign-in accounts that no longer
 * belong to any gym.
 */
export async function eraseGym(gymId, client = supabaseClient) {
    requireClient(client);
    const photos = await removeGymPhotos(gymId, client);
    const { data: users, error } = await client.rpc("gympulse_delete_gym", { p_gym_id: gymId });
    if (error) throw Object.assign(new Error("The gym's data could not be erased."), { cause: error, code: error.code });
    let accounts = 0;
    for (const userId of users || []) {
        const { count, error: countError } = await client.from("gym_users").select("gym_id", { count: "exact", head: true }).eq("user_id", userId);
        if (countError || count > 0) continue;
        const { error: deleteError } = await client.auth.admin.deleteUser(userId);
        if (deleteError) {
            logger.warn({ err: deleteError }, "A sign-in account of an erased gym could not be removed; remove it in Supabase › Authentication.");
            continue;
        }
        accounts += 1;
    }
    return { photos, accounts };
}

/** Erases every gym whose 7 days have passed (a few per run). Never throws. */
export async function purgeDueGyms(client = supabaseClient, { limit = 5 } = {}) {
    if (!client) return { erased: 0 };
    const { data, error } = await client
        .from("gyms")
        .select("id")
        .lte("deletion_scheduled_for", new Date().toISOString())
        .order("deletion_scheduled_for", { ascending: true })
        .limit(limit);
    if (error) {
        // Before migration 017 there is nothing to sweep.
        if (!MISSING.includes(error.code)) logger.error({ err: error }, "The gym deletion sweep could not read due gyms.");
        return { erased: 0 };
    }
    let erased = 0;
    for (const { id } of data || []) {
        try {
            const result = await eraseGym(id, client);
            erased += 1;
            logger.info({ action: "gym erased", ...result }, "A deleted gym's data was erased.");
        } catch (eraseError) {
            logger.error({ err: eraseError }, "A deleted gym could not be erased; the next sweep will try again.");
            captureException(eraseError, { tags: { area: "gym-deletion" } });
        }
    }
    return { erased };
}

/**
 * Runs the sweep shortly after start and then every hour. Returns a function that stops it. The same
 * hourly run deletes enquiries that did not join and have not changed for 90 days (migration 024), so
 * that happens even in a gym where nobody opens the Enquiries page.
 */
export function startGymDeletionSweep({ intervalMs = 60 * 60 * 1000, firstRunMs = 60 * 1000 } = {}) {
    const run = () => Promise.all([purgeDueGyms().catch(() => {}), purgeOldEnquiries().catch(() => 0)]);
    const first = setTimeout(run, firstRunMs);
    const every = setInterval(run, intervalMs);
    first.unref?.();
    every.unref?.();
    return () => {
        clearTimeout(first);
        clearInterval(every);
    };
}
