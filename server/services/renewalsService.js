import { supabaseClient } from "../config/database.js";
import { effectiveMembershipStatus } from "./membershipsService.js";

// One-tap renewal (migration 019). The new plan, the payment and the renewal record are saved by
// one database function in one transaction, scoped to the gym, so a failure saves nothing, and
// repeating a request with the same key saves nothing twice.

export class RenewalError extends Error {
    /** reason: a short code the app uses to word its message ("future_plan", "dates_changed", …). */
    constructor(status, message, reason = "") {
        super(message);
        this.status = status;
        this.reason = reason;
    }
}

const MISSING = ["PGRST202", "PGRST204", "PGRST205", "42883", "42P01", "42703"];

function databaseError(error) {
    const text = `${error?.message || ""} ${error?.details || ""}`;
    if (MISSING.includes(error?.code)) {
        return new RenewalError(503, "One-tap renewal is unavailable. Run migration 019_add_one_tap_renewal.sql in Supabase SQL Editor.", "unavailable");
    }
    if (error?.code === "P0002") return new RenewalError(404, error.message || "Member or plan not found.", "not_found");
    if (error?.code === "P0001") {
        const reason = /future_plan/.test(text) ? "future_plan" : /dates_changed/.test(text) ? "dates_changed" : /plan_inactive/.test(text) ? "plan_inactive" : "";
        return new RenewalError(409, error.message || "This renewal cannot be saved.", reason);
    }
    if (error?.code === "23P01") return new RenewalError(409, "This member already has a membership during those dates.", "overlap");
    if (error?.code === "22023") return new RenewalError(409, "This request was already used for another member. Close the sheet and try again.", "key_reused");
    if (error?.code === "23505") {
        if (/upi_reference/.test(text)) return new RenewalError(409, "This UPI reference (UTR) is already recorded for another payment.", "utr_taken");
        return new RenewalError(409, "Another save for this member was in progress. Please try again.", "busy");
    }
    if (error?.code === "23514") {
        if (/upi_reference/.test(text)) return new RenewalError(400, "A UPI reference (UTR) must be 12 digits, and only on a UPI payment.", "utr_invalid");
        if (/amount paid|fee cannot/i.test(text)) return new RenewalError(400, error.message, "amount");
        return new RenewalError(400, "Check the fee and the amount paid.", "amount");
    }
    return new RenewalError(500, "The database could not complete the renewal.");
}

/**
 * Renews a member in one transaction. input: { idempotency_key, plan_id, backdate, expected_start,
 * total_fees, amount_paid, method, upi_reference }. Returns { replayed, renewal, membership,
 * payment, balance }; replayed is true when this key was already saved (nothing new was created).
 */
export async function renewMember(memberId, input, { gymId, userId = null }, client = supabaseClient) {
    if (!client) throw new RenewalError(503, "Supabase is not configured.");
    if (!gymId) throw new RenewalError(403, "Gym is required.");
    const { data, error } = await client.rpc("gympulse_renew_member", {
        p_gym_id: gymId,
        p_member_id: memberId,
        p_idempotency_key: input.idempotency_key,
        p_plan_id: input.plan_id,
        p_backdate: input.backdate === true,
        p_expected_start: input.expected_start ?? null,
        p_total_fees: input.total_fees ?? null,
        p_amount_paid: input.amount_paid ?? 0,
        p_method: input.method || "cash",
        p_upi_reference: input.upi_reference ?? null,
        p_recorded_by: userId
    });
    if (error) throw databaseError(error);
    if (!data?.membership) throw new RenewalError(500, "The database did not return the renewal.");
    return { ...data, membership: { ...data.membership, effective_status: effectiveMembershipStatus(data.membership) } };
}

/** Renewal details (when, fee, paid) for these memberships, keyed by membership id. */
export async function renewalsForMemberships(membershipIds, gymId, client = supabaseClient) {
    if (!client || !gymId || !membershipIds.length) return new Map();
    const { data, error } = await client
        .from("membership_renewals")
        .select("membership_id,plan_price,fee,amount_paid,start_choice,created_at")
        .eq("gym_id", gymId)
        .in("membership_id", membershipIds);
    // Before migration 019 there is no table, and no renewal history to show.
    if (error) return new Map();
    return new Map((data || []).map((row) => [row.membership_id, {
        plan_price: Number(row.plan_price),
        fee: Number(row.fee),
        amount_paid: Number(row.amount_paid),
        start_choice: row.start_choice,
        created_at: row.created_at
    }]));
}
