// Plan holds (migration 021): who can put a plan on hold, for how long, and where the end date
// lands afterwards. One set of rules for the server and the app (the database repeats them when it
// saves). India dates (YYYY-MM-DD) throughout. No DOM or app imports.

import { dayDiff, plusDays } from "./memberStatus.js";

export const DEFAULT_MIN_HOLD_DAYS = 15;

/**
 * The hold limits a plan length gets when the plan sets none of its own:
 * up to 31 days no holds; up to 100 days 30 days and 1 hold; up to 190 days 30 days and 2 holds;
 * longer 60 days and 2 holds.
 */
export function defaultHoldLimits(durationDays) {
    const days = Number(durationDays) || 0;
    if (days <= 31) return { maxHoldDays: 30, maxHolds: 0 };
    if (days <= 100) return { maxHoldDays: 30, maxHolds: 1 };
    if (days <= 190) return { maxHoldDays: 30, maxHolds: 2 };
    return { maxHoldDays: 60, maxHolds: 2 };
}

/** The plan's own limits where it has them, the default for its length otherwise. */
export function holdLimits(plan, durationDays = plan?.duration_days) {
    const fallback = defaultHoldLimits(durationDays);
    const own = (value) => (value === null || value === undefined || value === "" ? null : Number(value));
    return {
        maxHoldDays: own(plan?.max_hold_days) ?? fallback.maxHoldDays,
        maxHolds: own(plan?.max_holds) ?? fallback.maxHolds,
        defaultMaxHoldDays: fallback.maxHoldDays,
        defaultMaxHolds: fallback.maxHolds
    };
}

/** "No holds" / "up to 30 days, 1 hold" – the default for a plan length, as one short line. */
export function holdLimitsText(limits) {
    if (!limits.maxHolds) return "no holds";
    return `up to ${limits.maxHoldDays} days, ${limits.maxHolds} ${limits.maxHolds === 1 ? "hold" : "holds"}`;
}

/** The return date must be at least the gym's minimum days away and within the plan's maximum. */
export function holdReturnProblem(startsOn, returnOn, { minHoldDays = DEFAULT_MIN_HOLD_DAYS, maxHoldDays }) {
    if (!returnOn) return "";
    const min = Math.max(Number(minHoldDays) || 0, 1);
    const days = dayDiff(startsOn, returnOn);
    if (days < min) return `The return date must be at least ${min} days after the hold starts.`;
    if (days > maxHoldDays) return `A hold on this plan can last at most ${maxHoldDays} days.`;
    return "";
}

/**
 * Whether this member's plan can be put on hold now, and if not, why (the words the sheet shows).
 *   status      the member's status (memberStatusFor)
 *   membership  the running plan
 *   plan        its membership_plans row (for max_hold_days / max_holds), or null
 *   holds       the member's holds (cancelled ones are ignored)
 *   settings    { min_hold_days, hold_fee_enabled, hold_fee_amount }
 * Returns { allowed, reason, code, limits, used, left, minHoldDays, firstStart, lastStart, fee }.
 */
export function holdEligibility({ status, membership, plan, holds = [], settings = {}, today }) {
    const minHoldDays = Number.isInteger(settings.min_hold_days) ? settings.min_hold_days : DEFAULT_MIN_HOLD_DAYS;
    const fee = settings.hold_fee_enabled && Number(settings.hold_fee_amount) > 0 ? Number(settings.hold_fee_amount) : 0;
    const limits = holdLimits(plan, membership?.duration_days);
    const used = membership ? holds.filter((hold) => !hold.cancelled && hold.membership_id === membership.id).length : 0;
    const base = { limits, used, left: Math.max(limits.maxHolds - used, 0), minHoldDays, fee, firstStart: today, lastStart: membership?.end_date || "" };
    const no = (code, reason) => ({ ...base, allowed: false, code, reason });
    if (status === "on_hold") return no("on_hold", "This plan is already on hold.");
    if (status === "in_grace") return no("not_running", "This plan has ended. Renew it instead.");
    if (status === "lapsed" || status === "old") return no("not_running", "This plan has ended. Renew it instead.");
    if (status === "upcoming") return no("not_running", "This plan hasn't started yet.");
    if (status !== "active" && status !== "expiring") return no("not_running", "Only a running plan can be put on hold.");
    if (limits.maxHolds === 0) return no("holds_not_allowed", `${membership.plan_name} plans can't be put on hold.`);
    if (used >= limits.maxHolds) {
        return no("no_holds_left", limits.maxHolds === 1 ? "The hold on this plan is already used."
            : limits.maxHolds === 2 ? "Both holds already used." : `All ${limits.maxHolds} holds already used.`);
    }
    return { ...base, allowed: true, code: "", reason: "" };
}

/** The start of a new hold must be today or later, and no later than the plan's last day. */
export function holdStartProblem(startsOn, { today, planEnd }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startsOn || ""))) return "Choose when the hold starts.";
    if (startsOn < today || startsOn > planEnd) return "The hold must start between today and the plan's last day.";
    return "";
}

/**
 * The numbers for a hold: remaining_days is the days from the hold's start to the plan's end,
 * inclusive; resumed on resumeOn the plan's new end is resumeOn + remaining_days - 1, which is the
 * old end plus the days held. Example: ends 31 March, hold from 1 March (31 left), back on
 * 4 March: 3 days held, new end 3 April.
 */
export function holdDates({ endBefore, startsOn, resumeOn }) {
    const remainingDays = dayDiff(startsOn, endBefore) + 1;
    const daysHeld = Math.max(0, dayDiff(startsOn, resumeOn));
    return { remainingDays, daysHeld, endAfter: plusDays(endBefore, daysHeld) };
}

/** The latest day a hold started on `startsOn` can run to. */
export function latestReturn(startsOn, maxHoldDays) {
    return plusDays(startsOn, maxHoldDays);
}
