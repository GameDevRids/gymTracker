import { supabaseClient } from "../config/database.js";

export function requireAuth({ allowNoGym = false, client = supabaseClient } = {}) {
    return async (request, response, next) => {
        const authorization = /^Bearer\s+([^\s]+)$/i.exec(request.get("Authorization") || "");
        if (!authorization) return response.status(401).json({ status: "error", message: "Authentication required." });
        if (!client) return response.status(503).json({ status: "error", message: "Authentication service is unavailable." });

        try {
            const { data: { user } = {}, error } = await client.auth.getUser(authorization[1]);
            if (error || !user) return response.status(401).json({ status: "error", message: "Access token is invalid or expired." });
            const { data: membership, error: gymError } = await client
                .from("gym_users")
                .select("gym_id,gyms(id,name)")
                .eq("user_id", user.id)
                .maybeSingle();
            if (gymError) {
                if (["PGRST204", "PGRST205", "42P01"].includes(gymError.code)) {
                    return response.status(503).json({ status: "error", message: "Gym authentication is unavailable. Run migration 007_create_gyms_and_auth.sql." });
                }
                return next(gymError);
            }
            if (!membership && !allowNoGym) {
                return response.status(403).json({ status: "error", message: "Create a gym to continue." });
            }
            request.authUser = user;
            request.gymId = membership?.gym_id || null;
            request.gym = membership?.gyms || null;
            next();
        } catch (error) {
            next(error);
        }
    };
}
