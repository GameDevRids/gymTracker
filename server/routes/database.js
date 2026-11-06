import express from "express";
import { supabaseClient, supabaseConfigured, supabaseConfigurationError } from "../config/database.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

router.get("/db-test", requireAuth(), async (request, response) => {
    if (!supabaseConfigured) {
        return response.status(503).json({
            status: "error",
            message: supabaseConfigurationError || "Supabase is not configured."
        });
    }

    try {
        const { error } = await supabaseClient
            .from("members")
            .select("id,gym_id,member_code,full_name,phone,email,gender,date_of_birth,membership_start_date,membership_end_date,status,notes,created_at,updated_at")
            .eq("gym_id", request.gymId)
            .limit(1);

        if (error) {
            if (error.code === "PGRST205" || error.code === "42P01" ||
                /could not find the table .*members|relation .*members.* does not exist/i.test(error.message)) {
                return response.status(503).json({
                    status: "error",
                    message: "Supabase is reachable, but the members table does not exist. Run the members migration in Supabase SQL Editor."
                });
            }
            if (error.code === "PGRST204" || error.code === "42703") {
                return response.status(503).json({
                    status: "error",
                    message: "Supabase is reachable, but the members table is missing required columns. Run the latest members migration in Supabase SQL Editor."
                });
            }

            return response.status(503).json({
                status: "error",
                message: "Supabase could not complete the database check. Verify the credentials, network, and service-role permissions."
            });
        }

        return response.json({
            status: "success",
            message: "Supabase database connected successfully"
        });
    } catch {
        return response.status(503).json({
            status: "error",
            message: "Could not reach Supabase. Check the project URL, service-role key, and network."
        });
    }
});

export default router;
