import { supabaseClient } from "../config/database.js";

export const GYM_COLUMNS = "gym_id,role,gyms(id,name,deletion_requested_at,deletion_scheduled_for)";
// Before migration 017 the deletion columns do not exist yet; the app keeps working without them.
const GYM_COLUMNS_BEFORE_017 = "gym_id,role,gyms(id,name)";
const MISSING_COLUMN = ["42703", "PGRST204"];

/** The signed-in user's gym link, with the gym's deletion state when the database has it. */
export async function loadGymMembership(client, userId) {
    const query = (columns) => client.from("gym_users").select(columns).eq("user_id", userId).maybeSingle();
    const result = await query(GYM_COLUMNS);
    if (result.error && MISSING_COLUMN.includes(result.error.code)) return query(GYM_COLUMNS_BEFORE_017);
    return result;
}

/**
 * allowPendingDeletion: routes that still work while the gym waits to be erased (the account
 * page, to cancel, and the owner's full data download). Everything else answers 423.
 */
export function requireAuth({ allowNoGym = false, allowPendingDeletion = false, client = supabaseClient } = {}) {
    return async (request, response, next) => {
        const authorization = /^Bearer\s+([^\s]+)$/i.exec(request.get("Authorization") || "");
        if (!authorization) return response.status(401).json({ status: "error", message: "Authentication required." });
        if (!client) return response.status(503).json({ status: "error", message: "Authentication service is unavailable." });

        try {
            const { data: { user } = {}, error } = await client.auth.getUser(authorization[1]);
            if (error || !user) return response.status(401).json({ status: "error", message: "Access token is invalid or expired." });
            const { data: membership, error: gymError } = await loadGymMembership(client, user.id);
            if (gymError) {
                if (["PGRST204", "PGRST205", "42P01"].includes(gymError.code)) {
                    return response.status(503).json({ status: "error", message: "Gym authentication is unavailable. Run migration 007_create_gyms_and_auth.sql." });
                }
                return next(gymError);
            }
            if (!membership && !allowNoGym) {
                return response.status(403).json({ status: "error", message: "Create a gym to continue." });
            }
            if (membership?.gyms?.deletion_scheduled_for && !allowPendingDeletion) {
                return response.status(423).json({
                    status: "error",
                    code: "gym_deletion_pending",
                    message: "This gym is scheduled for deletion. The owner can cancel it in the app."
                });
            }
            request.authUser = user;
            request.gymId = membership?.gym_id || null;
            request.gym = membership?.gyms || null;
            request.gymRole = membership?.role || null;
            next();
        } catch (error) {
            next(error);
        }
    };
}
