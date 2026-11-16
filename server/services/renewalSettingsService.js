import { supabaseClient } from "../config/database.js";

// Settings › Renewals and grace (migration 020): the gym's default grace period, the welcome-back
// discount for lapsed and old members, and how long lapsed members stay on the Lapsed list.
// Every login of the gym reads them (the Renew sheet needs them); only the owner changes them.

export class RenewalSettingsError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const columns = "id,expiry_grace_days,welcome_back_discount_type,welcome_back_discount_value,lapsed_list_days";

function databaseError(error) {
    if (["PGRST204", "PGRST205", "42703", "42P01"].includes(error?.code)) {
        return new RenewalSettingsError(503, "Renewal settings need the latest database update. Run migration 020_add_grace_and_lapsed_members.sql in Supabase SQL Editor.");
    }
    if (error?.code === "23514") return new RenewalSettingsError(400, "Check the values: grace 0 to 60 days, a percent of at most 100, and 7 to 365 days on the lapsed list.");
    return new RenewalSettingsError(500, "The database could not complete the renewal settings request.");
}

function publicSettings(row, role) {
    return {
        expiry_grace_days: row.expiry_grace_days,
        welcome_back_discount_type: row.welcome_back_discount_type,
        welcome_back_discount_value: Number(row.welcome_back_discount_value),
        lapsed_list_days: row.lapsed_list_days,
        can_edit: role === "owner"
    };
}

function requireContext(client, gymId) {
    if (!client) throw new RenewalSettingsError(503, "Supabase is not configured.");
    if (!gymId) throw new RenewalSettingsError(403, "Gym is required.");
}

export async function getRenewalSettings(gymId, role, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client.from("gyms").select(columns).eq("id", gymId).maybeSingle();
    if (error) throw databaseError(error);
    if (!data) throw new RenewalSettingsError(404, "Gym not found.");
    return publicSettings(data, role);
}

export async function saveRenewalSettings(gymId, values, role, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client.from("gyms").update(values).eq("id", gymId).select(columns).maybeSingle();
    if (error) throw databaseError(error);
    if (!data) throw new RenewalSettingsError(404, "Gym not found.");
    return publicSettings(data, role);
}

