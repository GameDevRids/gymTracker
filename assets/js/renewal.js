// One-tap renewal rules, shared by the browser (the sheet's preview) and the server (the Expiring
// list). No DOM or app imports. The database function gympulse_renew_member (migration 019) is the
// authority: it works out the same dates inside its transaction, and a test checks they agree.

const live = (membership) => membership.status !== "cancelled";

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
 * Where a renewal would start, from the member's plans (any order; cancelled ones ignored).
 *  - a plan already queued to start after today: blocked ("future_plan"), nothing to create;
 *  - a plan that is active or expiring: the day after it ends (no days lost, no overlap);
 *  - expired, or no plan: today, or with backdate the day after the last plan ended.
 * canBackdate is true when the member is expired and has an old plan to continue from, and
 * backdateStart is that date, so the sheet can offer "Start from day after old plan ended".
 */
export function renewalPlan(memberships, today, { backdate = false } = {}) {
    const plans = (memberships || []).filter(live);
    const queued = plans.filter((plan) => plan.start_date > today).map((plan) => plan.start_date).sort()[0] || null;
    if (queued) return { blocked: "future_plan", queuedStart: queued, startDate: null, choice: null, previous: null, canBackdate: false, backdateStart: null };
    const previous = [...plans].sort((a, b) => b.end_date.localeCompare(a.end_date)
        || String(b.created_at || "").localeCompare(String(a.created_at || "")))[0] || null;
    const active = Boolean(previous) && previous.start_date <= today && previous.end_date >= today;
    const afterPrevious = previous ? addDaysISO(previous.end_date, 1) : null;
    if (active) return { blocked: "", queuedStart: null, startDate: afterPrevious, choice: "after_current", previous, canBackdate: false, backdateStart: null };
    if (previous && backdate) return { blocked: "", queuedStart: null, startDate: afterPrevious, choice: "after_old_plan", previous, canBackdate: true, backdateStart: afterPrevious };
    return { blocked: "", queuedStart: null, startDate: today, choice: "today", previous, canBackdate: Boolean(previous), backdateStart: afterPrevious };
}

/**
 * True when the member's current plan is followed by another one that has not started yet: they
 * are already renewed, so they are not "expiring" (Expiring soon, the Overview count).
 */
export function hasLaterPlan(memberships, current) {
    if (!current) return false;
    return (memberships || []).some((plan) => live(plan) && plan.id !== current.id && plan.start_date > current.end_date);
}

/**
 * What the sheet shows under the amount: what is left on this renewal, and the member's whole
 * balance afterwards (older unpaid plans count too).
 */
export function renewalBalance({ fee, paid, outstandingBefore = 0 }) {
    const left = Math.max(0, Math.round((Number(fee) - Number(paid)) * 100) / 100);
    return { left, total: Math.round((Number(outstandingBefore) + left) * 100) / 100 };
}
