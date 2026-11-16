import { supabaseClient } from "../config/database.js";
import { effectiveMembershipStatus } from "./membershipsService.js";
import { gymStatusRules, indiaToday, openHolds, settleHolds } from "./memberStatusService.js";
import { holdEligibility, DEFAULT_MIN_HOLD_DAYS } from "../../assets/js/holds.js";
import { memberStatusFor } from "../../assets/js/memberStatus.js";

// Plan holds (migration 021). Starting, resuming and cancelling are each done by one database
// function in one transaction, scoped to the gym; repeating a start with the same key saves
// nothing twice. A hold's end date is worked out from dates (assets/js/memberStatus.js) and saved
// the next time the member is read (settleHolds).

export class HoldError extends Error {
    /** reason: a short code the app uses to word its message ("no_holds_left", "return_too_soon", …). */
    constructor(status, message, reason = "") {
        super(message);
        this.status = status;
        this.reason = reason;
    }
}

const MISSING = ["PGRST202", "PGRST204", "PGRST205", "42883", "42P01", "42703"];
const REASONS = ["already_on_hold", "not_running", "start_outside_plan", "holds_not_allowed", "no_holds_left", "return_too_soon",
    "return_too_late", "hold_cancelled", "not_started", "too_late_to_cancel", "on_hold"];

export function holdDatabaseError(error) {
    const text = `${error?.message || ""} ${error?.details || ""}`;
    if (MISSING.includes(error?.code)) {
        return new HoldError(503, "Plan holds need the latest database update. Run migration 021_add_plan_holds.sql in Supabase SQL Editor.", "unavailable");
    }
    if (error?.code === "P0002") return new HoldError(404, error.message || "Member or hold not found.", "not_found");
    if (error?.code === "P0001") {
        return new HoldError(409, error.message || "This hold cannot be saved.", REASONS.find((reason) => text.includes(reason)) || "");
    }
    if (error?.code === "22023") return new HoldError(409, "This request was already used for another member. Close the sheet and try again.", "key_reused");
    if (error?.code === "22004") return new HoldError(400, error.message || "Check the hold details.", "invalid");
    if (error?.code === "23505") {
        if (/upi_reference/.test(text)) return new HoldError(409, "This UPI reference (UTR) is already recorded for another payment.", "utr_taken");
        return new HoldError(409, "Another save for this member was in progress. Please try again.", "busy");
    }
    if (error?.code === "23514") {
        if (/upi_reference/.test(text)) return new HoldError(400, "A UPI reference (UTR) must be 12 digits, and only on a UPI payment.", "utr_invalid");
        return new HoldError(400, "Check the hold dates and the fee.", "invalid");
    }
    return new HoldError(500, "The database could not complete the hold.");
}

function requireContext(client, gymId) {
    if (!client) throw new HoldError(503, "Supabase is not configured.");
    if (!gymId) throw new HoldError(403, "Gym is required.");
}

/**
 * Puts the member's running plan on hold in one transaction (migration 021). input:
 * { idempotency_key, starts_on, planned_return_on (null = until they come back), method,
 * upi_reference }. method and the UTR only matter when the gym charges a hold fee.
 * Returns { replayed, hold, membership, payment, moved_plans }.
 */
export async function startHold(memberId, input, { gymId, userId = null }, client = supabaseClient) {
    requireContext(client, gymId);
    const { data, error } = await client.rpc("gympulse_start_hold", {
        p_gym_id: gymId,
        p_member_id: memberId,
        p_idempotency_key: input.idempotency_key,
        p_starts_on: input.starts_on,
        p_planned_return_on: input.planned_return_on ?? null,
        p_fee_method: input.method ?? null,
        p_fee_upi_reference: input.upi_reference ?? null,
        p_approved_by: userId
    });
    if (error) throw holdDatabaseError(error);
    return shape(data);
}

async function requireHoldOf(memberId, holdId, gymId, client) {
    const { data, error } = await client.from("membership_holds").select("id,member_id").eq("id", holdId).eq("gym_id", gymId).maybeSingle();
    if (error) throw holdDatabaseError(error);
    if (!data || data.member_id !== memberId) throw new HoldError(404, "Hold not found.", "not_found");
}

/**
 * Ends the hold today: the plan's end moves later by the days held (and any plan booked after it).
 * reason 'resumed' = staff tapped Resume; 'check_in' = the member came back (entrance poster, or
 * "Resume and check in"). Repeating it returns the same answer and changes nothing.
 */
export async function resumeHold(memberId, holdId, { gymId, userId = null, reason = "resumed" }, client = supabaseClient) {
    requireContext(client, gymId);
    await requireHoldOf(memberId, holdId, gymId, client);
    const { data, error } = await client.rpc("gympulse_resume_hold", { p_gym_id: gymId, p_hold_id: holdId, p_reason: reason, p_by: userId });
    if (error) throw holdDatabaseError(error);
    return shape(data);
}

/** Undoes a hold that starts today or later, as if it never happened; a hold fee is marked refunded. */
export async function cancelHold(memberId, holdId, { gymId, userId = null }, client = supabaseClient) {
    requireContext(client, gymId);
    await requireHoldOf(memberId, holdId, gymId, client);
    const { data, error } = await client.rpc("gympulse_cancel_hold", { p_gym_id: gymId, p_hold_id: holdId, p_by: userId });
    if (error) throw holdDatabaseError(error);
    return shape(data);
}

function shape(data) {
    if (!data?.hold) throw new HoldError(500, "The database did not return the hold.");
    return { ...data, membership: data.membership ? { ...data.membership, effective_status: effectiveMembershipStatus(data.membership) } : null };
}

export async function holdSettings(gymId, client = supabaseClient) {
    const { data, error } = await client.from("gyms").select("min_hold_days,hold_fee_enabled,hold_fee_amount").eq("id", gymId).maybeSingle();
    if (error) throw holdDatabaseError(error);
    return {
        min_hold_days: Number.isInteger(data?.min_hold_days) ? data.min_hold_days : DEFAULT_MIN_HOLD_DAYS,
        hold_fee_enabled: data?.hold_fee_enabled === true,
        hold_fee_amount: Number(data?.hold_fee_amount || 0)
    };
}

const historyColumns = "id,member_id,membership_id,starts_on,planned_return_on,latest_return_on,ended_on,end_reason,remaining_days,days_held,end_before,end_after,fee_amount,fee_payment_id,approved_by,ended_by,cancelled,cancelled_at,created_at";

// Who approved a hold: their role in this gym, and their sign-in email where it can be read.
async function approvers(userIds, gymId, client) {
    const names = new Map();
    if (!userIds.length) return names;
    const { data } = await client.from("gym_users").select("user_id,role").eq("gym_id", gymId).in("user_id", userIds);
    for (const row of data || []) names.set(row.user_id, { role: row.role === "owner" ? "Owner" : "Staff", email: null });
    await Promise.all([...names.keys()].map(async (userId) => {
        try {
            const { data: user } = await client.auth.admin.getUserById(userId);
            if (user?.user?.email) names.get(userId).email = user.user.email;
        } catch { /* the role is enough */ }
    }));
    return names;
}

/**
 * A member's holds, newest first (cancelled ones included, marked), with who approved each, the
 * hold fee's receipt, and what can be done now: { holds, eligibility, settings, status, hold,
 * membership }. eligibility is the shared rule (assets/js/holds.js): allowed, or the reason why not.
 */
export async function listMemberHolds(memberId, gymId, client = supabaseClient, today = indiaToday()) {
    requireContext(client, gymId);
    const { data: member, error: memberError } = await client.from("members").select("id").eq("id", memberId).eq("gym_id", gymId).maybeSingle();
    if (memberError) throw holdDatabaseError(memberError);
    if (!member) throw new HoldError(404, "Member not found.", "not_found");
    await settleHolds(gymId, memberId, client);

    const [rules, settings, plansResult, holdsResult, open] = await Promise.all([
        gymStatusRules(gymId, client).catch(() => ({ lapsedListDays: 60, defaultGraceDays: 0 })),
        holdSettings(gymId, client),
        client.from("member_memberships").select("id,plan_id,plan_name,duration_days,grace_days,start_date,end_date,status,created_at").eq("member_id", memberId).eq("gym_id", gymId),
        client.from("membership_holds").select(historyColumns).eq("member_id", memberId).eq("gym_id", gymId).order("created_at", { ascending: false }),
        openHolds(gymId, client, [memberId])
    ]);
    if (plansResult.error) throw holdDatabaseError(plansResult.error);
    if (holdsResult.error) throw holdDatabaseError(holdsResult.error);
    const memberships = plansResult.data || [];
    const holds = holdsResult.data || [];
    const state = memberStatusFor(memberships, today, { ...rules, holds: open });

    let plan = null;
    if (state.membership?.plan_id) {
        const { data } = await client.from("membership_plans").select("id,name,duration_days,max_hold_days,max_holds").eq("id", state.membership.plan_id).eq("gym_id", gymId).maybeSingle();
        plan = data || null;
    }
    const eligibility = holdEligibility({ status: state.status, membership: state.membership, plan, holds, settings, today });

    const paymentIds = holds.map((hold) => hold.fee_payment_id).filter(Boolean);
    const payments = new Map();
    if (paymentIds.length) {
        const { data } = await client.from("payments").select("id,receipt_number,amount,method,refunded_at").eq("gym_id", gymId).in("id", paymentIds);
        for (const row of data || []) payments.set(row.id, row);
    }
    const people = await approvers([...new Set(holds.flatMap((hold) => [hold.approved_by, hold.ended_by]).filter(Boolean))], gymId, client);
    return {
        status: state.status,
        hold: state.hold,
        scheduled_hold: state.scheduledHold,
        membership: state.membership,
        eligibility,
        settings,
        holds: holds.map((hold) => ({
            ...hold,
            fee_amount: Number(hold.fee_amount || 0),
            fee_payment: hold.fee_payment_id ? payments.get(hold.fee_payment_id) || null : null,
            approved_by_name: people.get(hold.approved_by) || null,
            ended_by_name: people.get(hold.ended_by) || null
        }))
    };
}
