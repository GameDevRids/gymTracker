import { supabaseClient } from "../config/database.js";

export class SummaryError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

/**
 * Totals for the Overview, Analytics and Payments pages, over every member and payment of the
 * gym (migration 015, gympulse_gym_summary). India dates. Money values are rounded to paise.
 */
export async function getGymSummary(gymId, { months = 6 } = {}, client = supabaseClient) {
    if (!client) throw new SummaryError(503, "Supabase is not configured.");
    if (!gymId) throw new SummaryError(403, "Gym is required.");
    const { data, error } = await client.rpc("gympulse_gym_summary", { p_gym_id: gymId, p_months: months });
    if (error) {
        if (["PGRST202", "42883", "PGRST205", "42P01"].includes(error.code)) {
            throw new SummaryError(503, "Gym totals are unavailable. Run migration 015_move_browser_data_to_database.sql in Supabase SQL Editor.");
        }
        throw new SummaryError(500, "The database could not calculate the gym totals.");
    }
    const summary = data || {};
    return {
        ...summary,
        outstanding_total: money(summary.outstanding_total),
        collected_this_month: money(summary.collected_this_month),
        collected_all_time: money(summary.collected_all_time),
        months: (summary.months || []).map((month) => ({
            ...month,
            collected: money(month.collected),
            outstanding: money(month.outstanding)
        })),
        active_by_plan: summary.active_by_plan || []
    };
}
