// Renewal rules, shared by the browser (the Renew sheet's preview) and the server. No DOM or app
// imports. The database function gympulse_renew_member (migration 020) is the authority: it works
// out the same start date inside its transaction, and a test checks they agree.

const live = (membership) => membership.status !== "cancelled";
const iso = (value) => String(value || "").slice(0, 10);

/** "2026-11-20" + days, on the calendar (no time zones involved). */
export function addDaysISO(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

/** The last day of a plan that starts on startDate: the start day counts as day one. */
export function planEndDate(startDate, durationDays) {
    return addDaysISO(startDate, Number(durationDays) - 1);
}

/**
 * Where a renewal starts, from the member's plans (any order; cancelled ones ignored):
 *  - a plan already booked to start after today: blocked ("future_plan"), nothing to create;
 *  - renewing before the plan ends: the day after it ends (no days lost, no overlap);
 *  - renewing after it ended (in grace, lapsed or old), or no plan: today, full length. The gap
 *    is forgiven, not counted.
 * endedOn is the last plan's end date when it has ended, for "Starts today – plan ended on …".
 */
export function renewalPlan(memberships, today) {
    const plans = (memberships || []).filter(live).map((plan) => ({ ...plan, start_date: iso(plan.start_date), end_date: iso(plan.end_date) }));
    const queued = plans.filter((plan) => plan.start_date > today).map((plan) => plan.start_date).sort()[0] || null;
    if (queued) return { blocked: "future_plan", queuedStart: queued, startDate: null, choice: null, previous: null, endedOn: "" };
    const previous = [...plans].sort((a, b) => b.end_date.localeCompare(a.end_date)
        || String(b.created_at || "").localeCompare(String(a.created_at || "")))[0] || null;
    if (previous && previous.start_date <= today && previous.end_date >= today) {
        return { blocked: "", queuedStart: null, startDate: addDaysISO(previous.end_date, 1), choice: "after_current", previous, endedOn: "" };
    }
    return { blocked: "", queuedStart: null, startDate: today, choice: "today", previous, endedOn: previous?.end_date || "" };
}

/**
 * A start date the owner typed: "" when it can be used, otherwise why not (it would overlap a
 * plan the member already has). The database checks the same.
 */
export function startDateProblem(memberships, startDate, durationDays) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ""))) return "Choose a start date.";
    const end = planEndDate(startDate, durationDays);
    const clash = (memberships || []).filter(live)
        .find((plan) => iso(plan.start_date) <= end && iso(plan.end_date) >= startDate);
    return clash ? "That date overlaps a plan the member already has. Choose a later date." : "";
}

/**
 * What the sheet shows under the amount: what is left on this renewal, and the member's whole
 * balance afterwards (older unpaid plans count too).
 */
export function renewalBalance({ fee, paid, outstandingBefore = 0 }) {
    const left = Math.max(0, Math.round((Number(fee) - Number(paid)) * 100) / 100);
    return { left, total: Math.round((Number(outstandingBefore) + left) * 100) / 100 };
}

/** The grace days a new plan will get: the plan's own, else the gym default. */
export function planGraceDays(plan, gymDefault = 0) {
    const days = Number(plan?.grace_days);
    return plan && plan.grace_days !== null && plan.grace_days !== undefined && Number.isInteger(days) ? days : Math.max(0, Number(gymDefault) || 0);
}

/** "Use suggested" grace by a plan's length: monthly 3, quarterly 4, six-month and yearly 5. */
export function suggestedGraceDays(durationDays) {
    const days = Number(durationDays);
    if (days <= 45) return 3;
    if (days <= 120) return 4;
    return 5;
}

/** The welcome-back discount on a price: an amount or a percent, never below ₹0. 0 = not set. */
export function welcomeBackDiscount(price, settings = {}) {
    const value = Number(settings.welcome_back_discount_value);
    const amount = settings.welcome_back_discount_type === "percent" ? Number(price) * value / 100 : value;
    if (!(amount > 0) || !(Number(price) > 0)) return 0;
    return Math.round(Math.min(amount, Number(price)) * 100) / 100;
}
