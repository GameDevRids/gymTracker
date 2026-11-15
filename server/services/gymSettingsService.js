import { supabaseClient } from "../config/database.js";

const contactColumns = ["phone", "address", "upi_id", "upi_payee_name"];
// Migration 015: preferences that used to live only in the browser. NULL = not chosen yet.
const preferenceColumns = ["language", "date_format", "expiry_reminder_days", "payment_reminders", "inactivity_reminders"];
const settingsColumns = ["gym_id", ...contactColumns, ...preferenceColumns, "updated_at"].join(",");

export const PREFERENCE_DEFAULTS = Object.freeze({
    language: "en",
    date_format: "DD MMM YYYY",
    expiry_reminder_days: 7,
    payment_reminders: true,
    inactivity_reminders: true
});

export class GymSettingsError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function requireContext(client, gymId) {
    if (!client) throw new GymSettingsError(503, "Supabase is not configured.");
    if (!gymId) throw new GymSettingsError(403, "Gym is required.");
}

function databaseError(error) {
    if (["PGRST204", "42703"].includes(error?.code)) {
        throw new GymSettingsError(503, "Gym preferences are unavailable. Run migration 015_move_browser_data_to_database.sql in Supabase SQL Editor.");
    }
    if (["PGRST205", "42P01"].includes(error?.code)) {
        throw new GymSettingsError(503, "Gym settings are unavailable. Run migration 011_add_upi_and_receipts.sql in Supabase SQL Editor.");
    }
    if (error?.code === "23514") throw new GymSettingsError(400, "Check the UPI ID, payee name, phone, address and preferences.");
    throw new GymSettingsError(500, "The database could not complete the gym settings request.");
}

/** Preferences with defaults filled in for anything not chosen yet. */
export function effectivePreferences(settings) {
    return Object.fromEntries(preferenceColumns.map((key) => [key, settings?.[key] ?? PREFERENCE_DEFAULTS[key]]));
}

/** The gym's name with its phone, address, UPI details and preferences; empty values are null. */
export async function getGymSettings(gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const [{ data: gym, error: gymError }, { data: settings, error }] = await Promise.all([
        client.from("gyms").select("id,name").eq("id", gymId).maybeSingle(),
        client.from("gym_settings").select(settingsColumns).eq("gym_id", gymId).maybeSingle()
    ]);
    if (gymError) databaseError(gymError);
    if (error) databaseError(error);
    if (!gym) throw new GymSettingsError(404, "Gym not found.");
    return {
        name: gym.name,
        phone: settings?.phone ?? null,
        address: settings?.address ?? null,
        upi_id: settings?.upi_id ?? null,
        upi_payee_name: settings?.upi_payee_name ?? null,
        ...effectivePreferences(settings),
        saved: Boolean(settings)
    };
}

/**
 * The language and date format to start the app with, read at sign-in. Never fails sign-in:
 * before migration 015 (or on any error) the defaults are used.
 */
export async function sessionPreferences(gymId, client = supabaseClient) {
    if (!client || !gymId) return { language: PREFERENCE_DEFAULTS.language, date_format: PREFERENCE_DEFAULTS.date_format };
    try {
        const { data, error } = await client.from("gym_settings").select("language,date_format").eq("gym_id", gymId).maybeSingle();
        const values = error ? {} : data || {};
        return { language: values.language ?? PREFERENCE_DEFAULTS.language, date_format: values.date_format ?? PREFERENCE_DEFAULTS.date_format };
    } catch {
        return { language: PREFERENCE_DEFAULTS.language, date_format: PREFERENCE_DEFAULTS.date_format };
    }
}

/** Saves only the fields sent; fields left out keep their saved values. */
export async function saveGymSettings(gymId, values, updatedBy = null, client = supabaseClient) {
    requireContext(client, gymId);
    if (values.name !== undefined) {
        const { error } = await client.from("gyms").update({ name: values.name }).eq("id", gymId);
        if (error) databaseError(error);
    }
    const changes = Object.fromEntries([...contactColumns, ...preferenceColumns]
        .filter((key) => values[key] !== undefined)
        .map((key) => [key, values[key]]));
    if (Object.keys(changes).length) {
        const { error } = await client
            .from("gym_settings")
            .upsert({ gym_id: gymId, ...changes, updated_by: updatedBy, updated_at: new Date().toISOString() }, { onConflict: "gym_id" });
        if (error) databaseError(error);
    }
    return getGymSettings(gymId, client);
}

/**
 * The one-time move of preferences an older version kept in one browser. Fills only the
 * preferences this gym has not chosen yet, so a second browser cannot overwrite newer choices.
 * Returns the names of the preferences that were filled.
 */
export async function fillUnsetPreferences(gymId, preferences, updatedBy = null, client = supabaseClient) {
    requireContext(client, gymId);
    const { data: current, error } = await client.from("gym_settings").select(settingsColumns).eq("gym_id", gymId).maybeSingle();
    if (error) databaseError(error);
    const filled = preferenceColumns.filter((key) => preferences[key] !== undefined && preferences[key] !== null && (current?.[key] ?? null) === null);
    if (!filled.length) return [];
    const { error: saveError } = await client
        .from("gym_settings")
        .upsert({
            gym_id: gymId,
            ...Object.fromEntries(filled.map((key) => [key, preferences[key]])),
            updated_by: updatedBy,
            updated_at: new Date().toISOString()
        }, { onConflict: "gym_id" });
    if (saveError) databaseError(saveError);
    return filled;
}
