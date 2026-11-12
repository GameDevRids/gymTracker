import { randomBytes } from "node:crypto";
import { supabaseClient } from "../config/database.js";
import { QR_TOKEN_PATTERN } from "../../assets/js/checkin.js";

// The gym's check-in settings (migration 013). Every check-in reads them, so the method that is
// switched off is refused and the expired-member policy is applied on the server.
export const checkinColumns = "id,name,checkin_method,expired_checkin_policy,expiry_grace_days,entrance_token,entrance_require_location,latitude,longitude,location_radius_m";

export class CheckinSettingsError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export const MIGRATION_MESSAGE = "Check-in settings are unavailable. Run migration 013_add_checkin_methods_and_member_devices.sql in Supabase SQL Editor.";

function databaseError(error) {
    if (["PGRST205", "42P01", "PGRST204", "42703"].includes(error?.code)) throw new CheckinSettingsError(503, MIGRATION_MESSAGE);
    if (error?.code === "23514") throw new CheckinSettingsError(400, "Check the check-in settings: grace days 0 to 60, radius 25 to 2000 m, and a location when the location check is on.");
    throw new CheckinSettingsError(500, "The database could not complete the check-in settings request.");
}

function requireContext(client, gymId) {
    if (!client) throw new CheckinSettingsError(503, "Supabase is not configured.");
    if (!gymId) throw new CheckinSettingsError(403, "Gym is required.");
}

/** The gym row with its check-in settings. */
export async function loadGymCheckin(gymId, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client.from("gyms").select(checkinColumns).eq("id", gymId).maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new CheckinSettingsError(404, "Gym not found.");
    return data;
}

/** The gym whose poster this is, or null when the token is unknown or the poster is switched off. */
export async function gymForEntranceToken(token, client = supabaseClient) {
    if (!client) throw new CheckinSettingsError(503, "Supabase is not configured.");
    if (!QR_TOKEN_PATTERN.test(String(token || ""))) return null;
    const { data, error } = await client.from("gyms").select(checkinColumns).eq("entrance_token", token).maybeSingle();
    if (error) databaseError(error);
    return data && data.checkin_method === "entrance_poster" ? data : null;
}

export function publicCheckinSettings(gym, role) {
    return {
        checkin_method: gym.checkin_method,
        expired_checkin_policy: gym.expired_checkin_policy,
        expiry_grace_days: gym.expiry_grace_days,
        entrance_require_location: gym.entrance_require_location === true,
        latitude: gym.latitude,
        longitude: gym.longitude,
        location_radius_m: gym.location_radius_m,
        // The poster is on the wall at the entrance, so every login of the gym may see its link.
        entrance_path: `/c/${gym.entrance_token}`,
        can_edit: role === "owner"
    };
}

export async function getCheckinSettings(gymId, role, client = supabaseClient) {
    return publicCheckinSettings(await loadGymCheckin(gymId, client), role);
}

export async function saveCheckinSettings(gymId, values, role, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client.from("gyms").update(values).eq("id", gymId).select(checkinColumns).maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new CheckinSettingsError(404, "Gym not found.");
    return publicCheckinSettings(data, role);
}

export function newEntranceToken() {
    return randomBytes(32).toString("base64url");
}

/** A new poster link; every printed poster with the old one stops working at once. */
export async function replaceEntranceToken(gymId, role, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client.from("gyms").update({ entrance_token: newEntranceToken() }).eq("id", gymId).select(checkinColumns).maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new CheckinSettingsError(404, "Gym not found.");
    return publicCheckinSettings(data, role);
}
