// Checks on what staff type for a member, shared by Add member, Edit member, Renew and Import.
// Most are questions, not errors: the owner may really mean it, so the form asks "Is that right?"
// and saves when they say yes. Only a date of birth in the future is refused.
import { addDays, formatDate, indiaISODate } from "./utils.js";
import { rupees } from "./paymentRules.js";

export const START_AHEAD_DAYS = 60;
export const START_BACK_DAYS = 365;
export const MIN_AGE = 10;
export const FEE_LOW_SHARE = 0.5;

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

/** "Start date is 20 Feb 2027. Is that right?" for a start more than 60 days ahead or a year back. */
export function startDateWarning(startDate, today = indiaISODate()) {
    if (!isDate(startDate)) return "";
    if (startDate > addDays(today, START_AHEAD_DAYS) || startDate < addDays(today, -START_BACK_DAYS)) {
        return `Start date is ${formatDate(startDate, "medium")}. Is that right?`;
    }
    return "";
}

/** Whole years between a date of birth and today. */
export function ageOn(dob, today = indiaISODate()) {
    const [by, bm, bd] = dob.split("-").map(Number);
    const [ty, tm, td] = today.split("-").map(Number);
    return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** { block } for a date of birth in the future, { warning } for an age under 10, else {}. */
export function dobCheck(dob, today = indiaISODate()) {
    if (!isDate(dob)) return {};
    if (dob > today) return { block: "Date of birth can't be in the future." };
    const age = ageOn(dob, today);
    if (age < MIN_AGE) return { warning: `This member would be ${age} year${age === 1 ? "" : "s"} old. Is that right?` };
    return {};
}

/** "Fee ₹X is different from the plan price ₹Y. Is that right?" below half the price, or above it. */
export function feeWarning(fee, planPrice) {
    const amount = Number(fee);
    const price = Number(planPrice);
    if (!Number.isFinite(amount) || !Number.isFinite(price) || price <= 0 || String(fee ?? "").trim() === "") return "";
    if (amount < price * FEE_LOW_SHARE || amount > price) return `Fee ${rupees(amount)} is different from the plan price ${rupees(price)}. Is that right?`;
    return "";
}

/**
 * Every check for one form: { block, warnings }. Pass only what the form has: Edit has no start
 * date or fee, Renew has no date of birth.
 */
export function memberWarnings({ startDate, dob, fee, planPrice, today = indiaISODate() } = {}) {
    const born = dobCheck(dob, today);
    const warnings = [startDateWarning(startDate, today), born.warning, feeWarning(fee, planPrice)].filter(Boolean);
    return { block: born.block || "", warnings };
}

/** The "Is that right?" box: the questions, with Go back and Yes, save. */
export function warningsHtml(warnings, { confirmLabel = "Yes, save" } = {}) {
    const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    return `<div class="note-box check-warnings" role="alert" data-check-warnings>
        <ul>${warnings.map((text) => `<li>${escape(text)}</li>`).join("")}</ul>
        <div class="check-warning-actions"><button class="button button-secondary button-small" type="button" data-check="back">Go back</button><button class="button button-primary button-small" type="button" data-check="confirm">${escape(confirmLabel)}</button></div>
    </div>`;
}

/**
 * Before saving a form: shows the questions once and waits. Resolves true to go ahead (nothing to
 * ask, or the owner tapped "Yes, save"), false when they tapped "Go back". The answer is kept for
 * these exact questions, so changing a value asks again.
 */
export function confirmWarnings(form, warnings, { anchor = null, confirmLabel } = {}) {
    if (!warnings.length) return Promise.resolve(true);
    const key = warnings.join("|");
    if (form.dataset.checksConfirmed === key) return Promise.resolve(true);
    form.querySelector("[data-check-warnings]")?.remove();
    const holder = document.createElement("div");
    holder.className = "field full";
    holder.innerHTML = warningsHtml(warnings, { confirmLabel });
    (anchor && anchor.isConnected ? anchor : form).insertAdjacentElement(anchor ? "beforebegin" : "beforeend", holder);
    holder.querySelector("[data-check='confirm']")?.focus();
    return new Promise((resolve) => {
        holder.addEventListener("click", (event) => {
            const choice = event.target.closest("[data-check]")?.dataset.check;
            if (!choice) return;
            holder.remove();
            if (choice === "confirm") form.dataset.checksConfirmed = key;
            resolve(choice === "confirm");
        });
    });
}
