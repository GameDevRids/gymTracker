// What a payment may be, shared by the Record payment form, the welcome message and the tests.
// The database (migration 025) enforces the same rules when a payment is saved; these only let the
// screens say so before the owner taps Save.

export const DUPLICATE_MINUTES = 10;

export const money = (value) => Math.round(Number(value || 0) * 100) / 100;

/** ₹1,000 or ₹1,250.50, in Indian grouping. */
export function rupees(value) {
    const amount = money(value);
    return `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export const isVoided = (payment) => (payment?.status || "paid") === "voided";

/** A plan payment that counts towards what is due: not a hold fee, not voided. */
export const countsTowardPlan = (payment) => (payment?.kind || "plan") === "plan" && !isVoided(payment);

/** Money that counts as collected: not voided, and not a hold fee given back. */
export const countsAsCollected = (payment) => !isVoided(payment) && !payment?.refunded_at;

/** Fee, paid and balance due on one membership. The fee is total_fees: the price after any discount. */
export function membershipBalance(membership, payments = []) {
    const fee = money(membership?.total_fees ?? membership?.price);
    const paid = money((payments || [])
        .filter((payment) => payment.membership_id === membership?.id && countsTowardPlan(payment))
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
    return { membership, fee, paid, balance: Math.max(0, money(fee - paid)) };
}

/** Every plan the member has (cancelled ones left out), oldest first, with what is due on each. */
export function balancesDue(memberships = [], payments = []) {
    return (memberships || [])
        .filter((membership) => membership && membership.status !== "cancelled")
        .sort((a, b) => String(a.start_date || "").localeCompare(String(b.start_date || "")) || String(a.created_at || "").localeCompare(String(b.created_at || "")))
        .map((membership) => membershipBalance(membership, payments));
}

/**
 * Which plan the form is for: the one asked for if something is due on it, otherwise the oldest
 * plan with something due. owing lists every plan with a balance (more than one: the owner picks).
 * Nothing due anywhere: selected is null.
 */
export function chooseMembership(balances = [], preferredId = "") {
    const owing = balances.filter((row) => row.balance > 0);
    const preferred = owing.find((row) => row.membership?.id === preferredId);
    return { selected: preferred || owing[0] || null, owing };
}

/** What stops this amount being saved, in the words the owner sees ("" = nothing). */
export function amountProblem(amount, balance) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return "Enter an amount greater than zero.";
    if (money(balance) <= 0) return "Already fully paid.";
    if (money(value) > money(balance)) return `Only ${rupees(balance)} is due.`;
    return "";
}

/**
 * The same amount for the same member saved in the last 10 minutes (not voided): a payment
 * that may be about to be recorded twice. Returns that payment or null.
 */
export function recentDuplicate(payments = [], { amount, now = Date.now(), minutes = DUPLICATE_MINUTES } = {}) {
    const since = Number(now) - minutes * 60 * 1000;
    return (payments || []).find((payment) => !isVoided(payment)
        && (payment.kind || "plan") === "plan"
        && money(payment.amount) === money(amount)
        && Date.parse(payment.created_at) >= since
        && Date.parse(payment.created_at) <= Number(now) + 60 * 1000) || null;
}

/** "You recorded ₹1,000 for suman a few minutes ago. Record it again?" */
export function duplicateQuestion(payment, memberName, now = Date.now()) {
    const minutes = Math.max(0, Math.round((Number(now) - Date.parse(payment.created_at)) / 60000));
    const when = minutes < 1 ? "just now" : minutes <= 5 ? "a few minutes ago" : `${minutes} minutes ago`;
    return `You recorded ${rupees(payment.amount)} for ${memberName || "this member"} ${when}. Record it again?`;
}

/** A clear message for each reason the server refuses a payment (error.code from the API). */
export function rejectionMessage(error) {
    const due = error?.details?.balance_due;
    switch (error?.code) {
        case "fully_paid": return "Already fully paid. Nothing more is due on this plan.";
        case "over_balance": return due === undefined || due === null ? error.message : `Only ${rupees(due)} is due.`;
        case "membership_required": return "Choose the plan this payment is for.";
        case "membership_cancelled": return "This plan was cancelled, so nothing is due on it.";
        case "utr_taken": return "This UPI reference (UTR) is already recorded for another payment.";
        case "key_reused": return "This form was already used for another member. Close it and try again.";
        case "busy": return "Another save for this member was in progress. Please try again.";
        case "unavailable": return "Payments need a database update. Ask the gym owner to run the latest migration.";
        default: return error?.message || "The payment could not be saved. Please try again.";
    }
}

/** A request key (UUID v4): one per opened form, so a retry or double tap saves only once. */
export function newRequestKey() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
