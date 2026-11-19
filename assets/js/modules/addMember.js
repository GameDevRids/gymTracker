// Add member: one form for the desk, built to take about 30 seconds. Full name, phone, plan (with the
// expiry under it), start date, fee (the plan's price, editable) and what was paid: "Paid in full",
// "Part payment" or "Not yet", with the method and a UPI QR. Everything else is under "More details".
// After saving, the member reads and taps their own WhatsApp consent on the staff phone ("I agree" /
// "No thanks", source member_desk), then the desk can send the welcome card and the receipt.
import { escapeHTML, formatINR, localISODate } from "../utils.js";
import { money, rupees } from "../paymentRules.js";
import { gymUpi, paymentLink, qrSvg } from "./upiPayments.js";
import { readUiPreferences } from "../storage.js";

export const PAYMENT_CHOICES = [["full", "Paid in full"], ["part", "Part payment"], ["none", "Not yet"]];
export const PAYMENT_METHODS = [["upi", "UPI"], ["cash", "Cash"], ["card", "Card"], ["other", "Other"]];
export const PHONE_HELP = "Each member needs their own phone number.";
export const PHONE_ERROR = "Enter a valid Indian mobile number: 10 digits starting with 6–9, optionally with +91. Each member needs their own phone number.";

function rememberedMethod() {
    try {
        const saved = readUiPreferences().renewMethod;
        return PAYMENT_METHODS.some(([value]) => value === saved) ? saved : "cash";
    } catch {
        return "cash";
    }
}

/**
 * What is paid now for this fee and choice: { amount, balance, problem }.
 * full: the whole fee; part: more than ₹0 and less than the fee; none: nothing.
 */
export function paymentNow({ choice = "full", fee, part }) {
    const total = money(fee);
    if (!Number.isFinite(total) || total < 0) return { amount: 0, balance: 0, problem: "Enter the fee (₹0 or more)." };
    if (choice === "none" || total === 0) return { amount: 0, balance: total, problem: "" };
    if (choice === "part") {
        const amount = money(part);
        if (String(part ?? "").trim() === "" || !Number.isFinite(amount) || amount <= 0) return { amount: 0, balance: total, problem: "Enter the amount paid now." };
        if (amount >= total) return { amount, balance: 0, problem: `A part payment is less than the fee (${rupees(total)}). Choose "Paid in full" instead.` };
        return { amount, balance: money(total - amount), problem: "" };
    }
    return { amount: total, balance: 0, problem: "" };
}

/** The new-member fields, in desk order. planField is the plan select (or its loading/error state). */
export function addMemberFieldsHtml({ planField, photoField = "", nameField, expiryPlaceholder }) {
    const method = rememberedMethod();
    return `${nameField}
        <div class="field"><label for="form-phone">Phone *</label><input id="form-phone" name="phone" type="tel" value="" autocomplete="off" inputmode="tel" maxlength="13" pattern="(?:\\+91)?[6-9][0-9]{9}" placeholder="9876543210" required aria-describedby="form-phone-help form-phone-error"><span id="form-phone-help" class="helper-text">${PHONE_HELP}</span><span id="form-phone-error" class="helper-text phone-error" role="alert" hidden>${PHONE_ERROR}</span></div>
        <div id="member-plan-field">${planField}</div>
        <div class="field full add-expiry"><span class="field-label" id="form-expiry-label">Expires</span><p class="readonly-value" id="form-expiry-text" aria-labelledby="form-expiry-label" aria-live="polite">${escapeHTML(expiryPlaceholder)}</p><input type="hidden" name="assignmentEndDate" value=""></div>
        <div class="field"><label for="form-assignmentStartDate">Start date *</label><input id="form-assignmentStartDate" name="assignmentStartDate" type="date" value="${localISODate()}" autocomplete="off" required></div>
        <div class="field"><label for="form-totalFees">Fee (₹) *</label><input id="form-totalFees" name="totalFees" type="number" inputmode="decimal" min="0" step="1" value="" autocomplete="off" required><span class="helper-text">The plan's price. Change it for a discount.</span></div>
        <fieldset class="field full add-payment"><legend>Payment</legend>
            <div class="renew-methods add-payment-choices">${PAYMENT_CHOICES.map(([value, label]) => `<label class="renew-method"><input type="radio" name="paymentChoice" value="${value}" ${value === "full" ? "checked" : ""}><span>${label}</span></label>`).join("")}</div>
            <div class="field" id="add-part-field" hidden><label for="form-partAmount">Amount paid now (₹) *</label><input id="form-partAmount" name="partAmount" type="number" inputmode="decimal" min="1" step="1" autocomplete="off"></div>
            <p class="helper-text" id="add-payment-summary" aria-live="polite"></p>
            <div id="add-method-field"><span class="field-label" id="add-method-label">Payment method</span>
                <div class="renew-methods" role="radiogroup" aria-labelledby="add-method-label">${PAYMENT_METHODS.map(([value, label]) => `<label class="renew-method"><input type="radio" name="paymentMethod" value="${value}" ${value === method ? "checked" : ""}><span>${label}</span></label>`).join("")}</div>
                <button class="button button-secondary button-small" type="button" data-add="qr" id="add-qr-button">Show UPI QR</button>
                <div class="renew-qr" id="add-qr" hidden></div>
            </div>
        </fieldset>
        <details class="field full more-details" id="add-more-details"><summary>More details</summary>
            <div class="form-grid more-details-grid">
                <div class="field"><label for="form-email">Email</label><input id="form-email" name="email" type="email" autocomplete="off"></div>
                <div class="field"><label for="form-dob">Date of birth</label><input id="form-dob" name="dob" type="date" max="${localISODate()}" autocomplete="off"></div>
                <div class="field"><label for="form-gender">Gender</label><select id="form-gender" name="gender" autocomplete="off"><option value="">Not specified</option>${["Female", "Male", "Prefer not to say"].map((item) => `<option>${item}</option>`).join("")}</select></div>
                <div class="field"><label for="form-emergencyContact">Emergency contact</label><input id="form-emergencyContact" name="emergencyContact" type="tel" autocomplete="off"></div>
                <div class="field full"><label for="form-notes">Notes</label><textarea id="form-notes" name="notes" autocomplete="off"></textarea></div>
                ${photoField}
            </div>
        </details>
        <p class="helper-text field full" id="member-assignment-error" role="alert" hidden></p>`;
}

/** Reads the payment part of the form. */
export function formPayment(form) {
    const choice = form.querySelector('[name="paymentChoice"]:checked')?.value || "full";
    const method = form.querySelector('[name="paymentMethod"]:checked')?.value || "cash";
    return { choice, method, ...paymentNow({ choice, fee: form.elements.totalFees?.value, part: form.elements.partAmount?.value }) };
}

/** Shows the amount box for a part payment, the method only when something is paid, and the QR. */
export function updateAddPayment(form, { memberCode = "", planName = "" } = {}) {
    if (!form?.elements?.totalFees) return;
    const payment = formPayment(form);
    const part = form.querySelector("#add-part-field");
    if (part) part.hidden = payment.choice !== "part";
    const paysNow = payment.choice !== "none" && money(form.elements.totalFees.value) > 0;
    const methodField = form.querySelector("#add-method-field");
    if (methodField) methodField.hidden = !paysNow;
    const summary = form.querySelector("#add-payment-summary");
    if (summary) {
        summary.textContent = payment.problem && form.elements.totalFees.value !== "" && (payment.choice !== "part" || form.elements.partAmount.value !== "")
            ? payment.problem
            : payment.amount > 0 ? `${formatINR(payment.amount)} paid now${payment.balance > 0 ? ` · ${formatINR(payment.balance)} still due` : ""}.`
                : form.elements.totalFees.value !== "" && money(form.elements.totalFees.value) > 0 ? `${formatINR(money(form.elements.totalFees.value))} still due.` : "";
    }
    const button = form.querySelector("#add-qr-button");
    const panel = form.querySelector("#add-qr");
    if (!button || !panel) return;
    const upi = gymUpi();
    const showQr = paysNow && payment.method === "upi";
    button.hidden = !showQr;
    if (!showQr) panel.hidden = true;
    button.disabled = !upi;
    button.title = upi ? "" : "Add your UPI ID in Settings first";
    button.textContent = panel.hidden ? "Show UPI QR" : "Hide UPI QR";
    if (panel.hidden || !upi) return;
    const { link, reason, message } = paymentLink({ amount: payment.amount, memberCode, planName });
    panel.innerHTML = link
        ? `${qrSvg(link, "UPI payment QR code")}<p class="helper-text">Scan with any UPI app to pay <strong>${escapeHTML(formatINR(payment.amount))}</strong> to ${escapeHTML(upi.upiId)}. Add the member once the payment arrives.</p>`
        : `<p class="helper-text" role="alert">${escapeHTML(reason === "no-amount" ? "Enter the amount paid to show the QR." : message || "The QR could not be made.")}</p>`;
}

/** Show / Hide UPI QR. */
export function toggleAddQr(form, details) {
    const panel = form.querySelector("#add-qr");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    updateAddPayment(form, details);
}

/** The words the member reads on the staff phone. */
export function memberConsentQuestion(gymName) {
    return `${gymName || "This gym"} may send you WhatsApp messages about your membership.`;
}

export function consentStepHtml({ gymName, memberName }) {
    return {
        title: "Hand the phone to the member",
        subtitle: `${escapeHTML(memberName)}, please read and choose.`,
        body: `<div class="consent-step"><p class="consent-question">${escapeHTML(memberConsentQuestion(gymName))}</p><p class="helper-text">You can ask the gym to stop at any time.</p><p class="helper-text field-error" id="member-consent-error" role="alert" hidden></p></div>`,
        footer: `<button class="button button-secondary consent-answer" type="button" data-member-consent="no">No thanks</button><button class="button button-primary consent-answer" type="button" data-member-consent="yes">I agree</button>`
    };
}

/**
 * After the member is added: what the desk can send next. Send welcome card needs WhatsApp consent
 * and a valid mobile; Send receipt needs a payment.
 */
export function addedActions({ memberId, canWelcome, paymentId = "", paid = 0, balance = 0 }) {
    const lines = [paid > 0 ? `${formatINR(paid)} received${balance > 0 ? ` · ${formatINR(balance)} still due` : ""}.` : balance > 0 ? `${formatINR(balance)} is due.` : ""].filter(Boolean);
    if (!canWelcome) lines.push("No WhatsApp consent, so no welcome message is sent.");
    const buttons = [
        canWelcome ? `<button class="button button-secondary" type="button" data-action="welcome-share-card" data-id="${escapeHTML(memberId)}">Send welcome card</button>` : "",
        paymentId ? `<button class="button button-secondary" type="button" data-action="receipt" data-id="${escapeHTML(paymentId)}">Send receipt</button>` : ""
    ].filter(Boolean).join("");
    return {
        body: `<div class="renew-success" role="status"><span class="renew-tick" aria-hidden="true">✓</span><h3>Member added</h3>${lines.map((line) => `<p class="helper-text">${escapeHTML(line)}</p>`).join("")}</div>`,
        footer: `<button class="button button-secondary" type="button" data-action="profile" data-id="${escapeHTML(memberId)}">Open profile</button>${buttons}<button class="button button-primary" type="button" data-action="close-modal">Done</button>`
    };
}
