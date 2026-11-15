import { supabaseClient } from "../config/database.js";

export class MemberImportError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// Problems the database names (a row, a plan, a duplicate phone): shown to the owner as they are.
const OWNER_FIXABLE = new Set(["22023", "23505", "23P01", "P0001", "P0002"]);

/**
 * Saves an import in one database transaction (migration 016, gympulse_import_members):
 * new plans, members, their plans and amounts paid. If any row fails, nothing is saved.
 * Returns { created, updated, memberships, payments, plans_created }.
 */
export async function importMembers(payload, gymId, client = supabaseClient) {
    if (!client) throw new MemberImportError(503, "Supabase is not configured.");
    if (!gymId) throw new MemberImportError(403, "Gym is required.");
    const { data, error } = await client.rpc("gympulse_import_members", { p_gym_id: gymId, p_payload: payload });
    if (error) {
        if (["PGRST202", "42883"].includes(error.code)) {
            throw new MemberImportError(503, "Member import is unavailable. Run migration 016_add_member_import.sql in Supabase SQL Editor.");
        }
        if (OWNER_FIXABLE.has(error.code) && error.message) {
            const conflict = ["23505", "23P01"].includes(error.code);
            throw new MemberImportError(conflict ? 409 : 400, `Nothing was saved. ${error.message}`);
        }
        throw new MemberImportError(500, "The database could not save the import. Nothing was saved.");
    }
    return {
        created: Number(data?.created || 0),
        updated: Number(data?.updated || 0),
        memberships: Number(data?.memberships || 0),
        payments: Number(data?.payments || 0),
        plans_created: Number(data?.plans_created || 0)
    };
}
