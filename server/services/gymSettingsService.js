import { supabaseClient } from "../config/database.js";

const settingsColumns = "gym_id,phone,address,upi_id,upi_payee_name,updated_at";

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
    if (["PGRST205", "42P01", "PGRST204", "42703"].includes(error?.code)) {
        throw new GymSettingsError(503, "Gym settings are unavailable. Run migration 011_add_upi_and_receipts.sql in Supabase SQL Editor.");
    }
    if (error?.code === "23514") throw new GymSettingsError(400, "Check the UPI ID, payee name, phone and address.");
    throw new GymSettingsError(500, "The database could not complete the gym settings request.");
}

/** The gym's name with its phone, address and UPI details; empty values are null. */
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
        saved: Boolean(settings)
    };
}

export async function saveGymSettings(gymId, values, updatedBy = null, client = supabaseClient) {
    requireContext(client, gymId);
    if (values.name !== undefined) {
        const { error } = await client.from("gyms").update({ name: values.name }).eq("id", gymId);
        if (error) databaseError(error);
    }
    const { error } = await client
        .from("gym_settings")
        .upsert({
            gym_id: gymId,
            phone: values.phone ?? null,
            address: values.address ?? null,
            upi_id: values.upi_id ?? null,
            upi_payee_name: values.upi_payee_name ?? null,
            updated_by: updatedBy,
            updated_at: new Date().toISOString()
        }, { onConflict: "gym_id" });
    if (error) databaseError(error);
    return getGymSettings(gymId, client);
}
