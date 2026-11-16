// A member's status, worked out from their plans' dates only (no nightly job). The server uses
// it for every list, count, check-in and API answer; the app imports the same file only to update
// a screen at once after a save. India dates (YYYY-MM-DD) throughout. No DOM or app imports.
//
//   active     a plan covers today with more than 7 days left, or a later plan is already booked
//   expiring   a plan covers today with 7 days or fewer left, and nothing is booked after it
//   upcoming   nothing covers today, but a plan is booked to start later
//   in_grace   the last plan ended, and that membership's grace days have not run out
//   lapsed     grace has run out, and the plan ended no more than lapsedListDays ago
//   old        the plan ended more than lapsedListDays ago
//   none       the member has never had a plan

export const EXPIRING_DAYS = 7;
// "Remind on WhatsApp" is offered from this many days before the end, and all through grace.
export const REMIND_DAYS = 3;
export const DEFAULT_LAPSED_LIST_DAYS = 60;

export const STATUS_LABELS = {
    active: "Active",
    expiring: "Expiring",
    upcoming: "Upcoming",
    in_grace: "In grace",
    lapsed: "Lapsed",
    old: "Old member",
    none: "No plan"
};

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function dayDiff(from, to) {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function plusDays(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

/** The last day of grace after a plan: its end date plus its own grace days. */
export function graceUntil(membership, defaultGraceDays = 0) {
    if (!membership?.end_date) return "";
    return plusDays(String(membership.end_date).slice(0, 10), graceOf(membership, defaultGraceDays));
}

function graceOf(membership, defaultGraceDays) {
    const days = Number(membership?.grace_days);
    return Number.isInteger(days) && days >= 0 ? days : Math.max(0, Number(defaultGraceDays) || 0);
}

const live = (plan) => plan && plan.status !== "cancelled";
const iso = (value) => String(value || "").slice(0, 10);

/**
 * The member's status from all their plans (any order). Returns
 * { status, membership, daysLeft, endedOn, daysSinceEnd, graceDays, graceUntil, graceDaysLeft, nextStart }:
 * membership is the plan that decides the status (the one covering today, the one booked, or
 * the last one that ended). defaultGraceDays only applies to plans saved before migration 020.
 */
export function memberStatusFor(memberships, today, { lapsedListDays = DEFAULT_LAPSED_LIST_DAYS, defaultGraceDays = 0 } = {}) {
    const plans = (memberships || []).filter(live).map((plan) => ({ ...plan, start_date: iso(plan.start_date), end_date: iso(plan.end_date) }));
    const base = { membership: null, daysLeft: null, endedOn: "", daysSinceEnd: null, graceDays: null, graceUntil: "", graceDaysLeft: null, nextStart: "" };
    if (!plans.length) return { ...base, status: "none" };
    const booked = plans.filter((plan) => plan.start_date > today).sort((a, b) => a.start_date.localeCompare(b.start_date));
    const nextStart = booked[0]?.start_date || "";
    const covering = plans.filter((plan) => plan.start_date <= today && plan.end_date >= today)
        .sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
    if (covering) {
        const daysLeft = dayDiff(today, covering.end_date);
        const graceDays = graceOf(covering, defaultGraceDays);
        return {
            ...base,
            status: !nextStart && daysLeft <= EXPIRING_DAYS ? "expiring" : "active",
            membership: covering,
            daysLeft,
            graceDays,
            graceUntil: plusDays(covering.end_date, graceDays),
            nextStart
        };
    }
    if (booked.length) return { ...base, status: "upcoming", membership: booked[0], nextStart };
    const last = [...plans].sort((a, b) => b.end_date.localeCompare(a.end_date)
        || String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    const graceDays = graceOf(last, defaultGraceDays);
    const daysSinceEnd = dayDiff(last.end_date, today);
    const ended = { ...base, membership: last, endedOn: last.end_date, daysSinceEnd, graceDays, graceUntil: plusDays(last.end_date, graceDays) };
    if (daysSinceEnd <= graceDays) return { ...ended, status: "in_grace", graceDaysLeft: graceDays - daysSinceEnd };
    if (daysSinceEnd <= lapsedListDays) return { ...ended, status: "lapsed" };
    return { ...ended, status: "old" };
}

/**
 * What a check-in does for a status. Active, expiring and upcoming (a plan already paid for) are
 * checked in; in grace is checked in with a warning; lapsed, old and no plan are not checked in
 * ("Please renew at the desk"). result keeps the names the check-in screens already use.
 * stored is the value saved with the check-in (the attendance table's own status list).
 */
export function checkInDecision(status) {
    switch (status) {
        case "active":
        case "expiring": return { result: "checked_in", allowed: true, stored: "active" };
        case "upcoming": return { result: "upcoming", allowed: true, stored: "upcoming" };
        case "in_grace": return { result: "grace", allowed: true, stored: "grace" };
        case "lapsed":
        case "old": return { result: "expired", allowed: false, stored: "expired" };
        default: return { result: "no_membership", allowed: false, stored: "none" };
    }
}

/** True when the Expiring board offers "Remind on WhatsApp": 3 days or fewer left, or in grace. */
export function remindable(state) {
    return state.status === "in_grace" || (state.status === "expiring" && state.daysLeft <= REMIND_DAYS);
}
