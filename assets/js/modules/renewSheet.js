// The Renew sheet: one screen to renew a member, from the Expiring board, the profile, the
// members and renewals lists, and the check-in result card. Plan, price, payment and the new
// dates are all on it, so renewing with nothing changed is two taps: Renew, then "Renew and
// record". The database saves the plan, the payment and the renewal in one transaction
// (migration 019), and the request carries a key made when the sheet opens, so a double tap or a
// retry after a slow network never renews twice.
import { apiClient } from "../api/apiClient.js";
import { fetchActivePlans } from "../api/plansApi.js";
import { fetchMemberMembershipHistory } from "../api/membershipsApi.js";
import { openModal, closeModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { escapeHTML, formatDate, formatINR, formatPlanDuration, indiaISODate } from "../utils.js";
import { getMember, memberBalance } from "../state.js";
import { planEndDate, renewalBalance, renewalPlan } from "../renewal.js";
import { gymUpi, paymentLink, prepareReceiptShare, qrSvg } from "./upiPayments.js";
import { loadMemberMembershipHistory, setMemberCurrentMembership } from "./memberMemberships.js";
import { readUiPreferences, saveUiPreferences } from "../storage.js";

const METHODS = [["upi", "UPI"], ["cash", "Cash"], ["card", "Card"], ["other", "Other"]];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- What the sheet shows, as plain data (no DOM) ----------

const money = (value) => (value === "" || value === null || value === undefined ? NaN : Number(value));

/**
 * Everything the sheet needs from its inputs: the new plan's dates, any warning, what is left to
 * pay, the button's label, the problems that keep it disabled, and the request to send.
 * plans: active plans; memberships: the member's plan history; fee and paid come from the fields.
 */
export function renewView({ plans, memberships, today, planId, backdate = false, fee, paid, method = "cash", utr = "", outstandingBefore = 0 }) {
    const start = renewalPlan(memberships, today, { backdate });
    if (start.blocked) return { blocked: start.blocked, queuedStart: start.queuedStart, errors: [] };
    const plan = plans.find((item) => item.id === planId) || null;
    const feeValue = money(fee);
    const paidValue = money(paid);
    const errors = [];
    if (!plan) errors.push("Choose a plan.");
    if (!Number.isFinite(feeValue) || feeValue < 0) errors.push("Enter the price (₹0 or more).");
    if (!Number.isFinite(paidValue) || paidValue < 0) errors.push("Enter the amount paid (₹0 or more).");
    else if (Number.isFinite(feeValue) && paidValue > feeValue) errors.push("The amount paid cannot be more than the price. Record older dues with Record payment.");
    const utrText = String(utr || "").replace(/\s/g, "");
    if (method === "upi" && paidValue > 0 && utrText && !/^\d{12}$/.test(utrText)) errors.push("The UPI reference (UTR) is 12 digits.");
    const end = plan ? planEndDate(start.startDate, plan.duration_days) : "";
    const balance = errors.some((message) => /price|paid/.test(message))
        ? { left: 0, total: Math.round(Number(outstandingBefore) * 100) / 100 }
        : renewalBalance({ fee: feeValue, paid: paidValue, outstandingBefore });
    const payable = Number.isFinite(paidValue) ? paidValue : 0;
    return {
        blocked: "",
        errors,
        plan,
        startDate: start.startDate,
        endDate: end,
        choice: start.choice,
        canBackdate: start.canBackdate,
        backdateStart: start.backdateStart,
        previous: start.previous,
        warning: end && end < today ? `This plan would already have ended on ${formatDate(end)}, so the member would still show as expired.` : "",
        balance,
        label: payable > 0 ? `Renew and record ${formatINR(payable)}` : "Renew",
        request: errors.length ? null : {
            plan_id: plan.id,
            backdate: start.choice === "after_old_plan",
            expected_start: start.startDate,
            total_fees: feeValue,
            amount_paid: paidValue,
            method,
            ...(method === "upi" && paidValue > 0 && utrText ? { upi_reference: utrText } : {})
        }
    };
}

const CHOICE_NOTE = {
    after_current: "Starts the day after the current plan ends, so no days are lost.",
    today: "Starts today.",
    after_old_plan: "Continues from the day after the old plan ended."
};

// ---------- The sheet ----------

let sheet = null; // { memberId, plans, memberships, key, today, onChanged, saving, touched }

function newKey() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16).padStart(12, "0")}-0000-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, "0").slice(0, 12)}`;
}

function rememberedMethod() {
    const saved = readUiPreferences().renewMethod;
    return METHODS.some(([value]) => value === saved) ? saved : "cash";
}

function modalParts() {
    const modal = document.querySelector("#modal-root .modal");
    return { modal, body: modal?.querySelector(".modal-body"), footer: modal?.querySelector(".modal-footer") };
}

function isOpen(token) {
    return sheet?.token === token && Boolean(document.querySelector("#modal-root .renew-sheet"));
}

function planOptions(plans, selected) {
    return plans.map((plan) => `<option value="${escapeHTML(plan.id)}" ${plan.id === selected ? "selected" : ""}>${escapeHTML(plan.name)} · ${escapeHTML(formatPlanDuration(plan.duration_days))} · ${formatINR(plan.price)}</option>`).join("");
}

function renderForm(defaults) {
    const methods = METHODS.map(([value, label]) => `<label class="renew-method"><input type="radio" name="method" value="${value}" ${value === defaults.method ? "checked" : ""}><span>${label}</span></label>`).join("");
    return `<form id="renew-form" class="renew-form" novalidate>
        <div class="field"><label for="renew-plan">Plan</label><select id="renew-plan" name="plan_id">${defaults.planId ? "" : `<option value="">Choose a plan</option>`}${planOptions(sheet.plans, defaults.planId)}</select></div>
        <div class="field"><label for="renew-fee">Price (₹)</label><input id="renew-fee" name="fee" type="number" inputmode="decimal" min="0" step="1" value="${escapeHTML(String(defaults.fee))}"><span class="helper-text" id="renew-fee-note"></span></div>
        <div class="renew-dates" id="renew-dates" aria-live="polite"></div>
        <label class="renew-backdate" id="renew-backdate" hidden><input type="checkbox" name="backdate"> <span></span></label>
        <p class="helper-text renew-warning" id="renew-warning" role="status" hidden></p>
        <fieldset class="renew-payment">
            <legend>Payment</legend>
            <div class="field"><label for="renew-paid">Amount paid (₹)</label><input id="renew-paid" name="paid" type="number" inputmode="decimal" min="0" step="1" value="${escapeHTML(String(defaults.fee))}"></div>
            <div class="renew-methods" role="radiogroup" aria-label="Payment method">${methods}</div>
            <div class="field" id="renew-utr-field" hidden><label for="renew-utr">UPI reference (UTR, optional)</label><input id="renew-utr" name="utr" inputmode="numeric" maxlength="14" autocomplete="off"></div>
            <p class="renew-balance" id="renew-balance" aria-live="polite"></p>
            <button class="button button-secondary" type="button" data-renew="qr" id="renew-qr-button">Show UPI QR</button>
            <div class="renew-qr" id="renew-qr" hidden></div>
        </fieldset>
        <p class="helper-text field-error" id="renew-error" role="alert" hidden></p>
    </form>`;
}

function readFields(form) {
    return {
        planId: form.elements.plan_id.value,
        fee: form.elements.fee.value,
        paid: form.elements.paid.value,
        method: form.elements.method.value || "cash",
        utr: form.elements.utr.value,
        backdate: form.elements.backdate.checked
    };
}

function currentView(form) {
    const member = getMember(sheet.memberId);
    return renewView({
        plans: sheet.plans,
        memberships: sheet.memberships,
        today: sheet.today,
        outstandingBefore: member ? memberBalance(member) : 0,
        ...readFields(form)
    });
}

/** Redraws the dates, balance, QR and button from the fields. */
function update(form) {
    const view = currentView(form);
    const submit = document.querySelector("#renew-submit");
    const set = (selector, html, hidden = false) => {
        const element = form.querySelector(selector);
        if (!element) return;
        element.innerHTML = html;
        element.hidden = hidden;
    };
    form.elements.utr.closest("#renew-utr-field").hidden = form.elements.method.value !== "upi";
    if (view.blocked) return;
    const list = view.plan ? view.plan.price : null;
    const fee = money(form.elements.fee.value);
    form.querySelector("#renew-fee-note").textContent = list === null ? ""
        : Number.isFinite(fee) && fee < list ? `List price ${formatINR(list)}, discount ${formatINR(list - fee)}`
            : Number.isFinite(fee) && fee > list ? `List price ${formatINR(list)}` : `List price ${formatINR(list)}`;
    set("#renew-dates", view.plan
        ? `<span>New plan</span><strong>${escapeHTML(formatDate(view.startDate))} → ${escapeHTML(formatDate(view.endDate))}</strong><small>${escapeHTML(CHOICE_NOTE[view.choice] || "")}</small>`
        : `<span>New plan</span><strong>Choose a plan</strong><small>${escapeHTML(CHOICE_NOTE[view.choice] || "")}</small>`);
    const backdate = form.querySelector("#renew-backdate");
    backdate.hidden = !view.canBackdate;
    if (view.canBackdate) backdate.querySelector("span").textContent = `Start from day after old plan ended (${formatDate(view.backdateStart)})`;
    const warning = form.querySelector("#renew-warning");
    warning.textContent = view.warning;
    warning.hidden = !view.warning;
    const { left, total } = view.balance;
    const before = total - left;
    form.querySelector("#renew-balance").innerHTML = left > 0
        ? `Left on this renewal: <strong>${formatINR(left)}</strong>${before > 0 ? ` · total balance <strong>${formatINR(total)}</strong>` : ""}`
        : before > 0 ? `Paid in full · older balance still due: <strong>${formatINR(before)}</strong>` : "Paid in full";
    // A field problem, or what the server last said; either stays until it is dealt with.
    const problem = form.querySelector("#renew-error");
    const message = (!sheet.quiet && view.errors[0]) || sheet.serverError || "";
    problem.textContent = message;
    problem.hidden = !message;
    if (submit) {
        submit.textContent = view.label;
        submit.disabled = sheet.saving || Boolean(view.errors.length);
    }
    updateQr(form, view);
}

function updateQr(form, view) {
    const panel = form.querySelector("#renew-qr");
    const button = form.querySelector("#renew-qr-button");
    const upi = gymUpi();
    button.disabled = !upi;
    button.textContent = panel.hidden ? "Show UPI QR" : "Hide UPI QR";
    if (!upi) {
        button.title = "Add your UPI ID in Settings first";
        return;
    }
    if (panel.hidden) return;
    const amount = money(form.elements.paid.value);
    const member = getMember(sheet.memberId);
    const { link, reason, message } = paymentLink({ amount, memberCode: member?.memberCode || "", planName: view.plan?.name || "" });
    panel.innerHTML = link
        ? `${qrSvg(link, "UPI payment QR code")}<p class="helper-text">Scan with any UPI app to pay <strong>${escapeHTML(formatINR(amount))}</strong> to ${escapeHTML(upi.upiId)}. Save the renewal once the payment arrives.</p>`
        : `<p class="helper-text" role="alert">${escapeHTML(reason === "no-amount" ? "Enter an amount paid to show the QR." : message || "The QR could not be made.")}</p>`;
}

function blockedBody(view) {
    return `<div class="renew-blocked" role="alert"><p><strong>This member already has a plan starting on ${escapeHTML(formatDate(view.queuedStart))}.</strong></p><p class="helper-text">Renewing now would overlap it, so nothing was created. The new plan is already queued; the member will move onto it automatically.</p></div>`;
}

const loadingBody = `<div class="empty-state" role="status">Loading plans…</div>`;
const cancelFooter = `<button class="button button-secondary" data-action="close-modal" type="button">Close</button>`;

/**
 * Opens the Renew sheet for a member. onChanged(result) runs after a renewal is saved, so the
 * lists behind the sheet (Expiring soon, totals, payments) can refresh.
 */
export async function openRenewSheet(memberId, { onChanged = () => {} } = {}) {
    const member = getMember(memberId);
    if (!member || !UUID.test(memberId)) {
        toast("This member could not be found. Refresh the page and try again.", "error");
        return;
    }
    const token = Symbol("renew");
    sheet = { token, memberId, plans: [], memberships: [], key: newKey(), today: indiaISODate(), onChanged, saving: false, quiet: true, serverError: "" };
    openModal({ title: `Renew ${escapeHTML(member.name)}`, subtitle: "", body: loadingBody, footer: cancelFooter });
    document.querySelector("#modal-root .modal")?.classList.add("renew-sheet");
    try {
        const [plans, memberships] = await Promise.all([fetchActivePlans(), fetchMemberMembershipHistory(memberId)]);
        if (!isOpen(token)) return;
        sheet.plans = plans;
        sheet.memberships = memberships;
        sheet.today = indiaISODate();
        showForm();
    } catch (error) {
        if (!isOpen(token)) return;
        const { body } = modalParts();
        body.innerHTML = `<div class="empty-state" role="alert"><p>${escapeHTML(error.message || "The plans could not be loaded.")}</p><button class="button button-secondary" type="button" data-renew="retry">Try again</button></div>`;
        body.querySelector('[data-renew="retry"]').addEventListener("click", () => openRenewSheet(memberId, { onChanged }));
    }
}

function showForm() {
    const { body, footer } = modalParts();
    if (!body) return;
    if (!sheet.plans.length) {
        body.innerHTML = `<div class="empty-state"><p>No active plans are available.</p><button class="button button-secondary" data-action="go-to-plans" type="button">Manage plans</button></div>`;
        footer.innerHTML = cancelFooter;
        return;
    }
    const start = renewalPlan(sheet.memberships, sheet.today);
    if (start.blocked) {
        body.innerHTML = blockedBody({ queuedStart: start.queuedStart });
        footer.innerHTML = cancelFooter;
        return;
    }
    const previousPlan = sheet.plans.find((plan) => plan.id === start.previous?.plan_id);
    const planId = previousPlan?.id || (sheet.plans.length === 1 ? sheet.plans[0].id : "");
    const price = (previousPlan || sheet.plans.find((plan) => plan.id === planId))?.price ?? "";
    body.innerHTML = renderForm({ planId, fee: price, method: rememberedMethod() });
    footer.innerHTML = `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button button-primary" type="submit" form="renew-form" id="renew-submit">Renew</button>`;
    const form = body.querySelector("#renew-form");
    sheet.touched = { paid: false };
    sheet.quiet = !planId;
    form.addEventListener("input", (event) => onInput(form, event));
    form.addEventListener("change", (event) => onInput(form, event));
    form.addEventListener("click", (event) => {
        if (!event.target.closest('[data-renew="qr"]')) return;
        const panel = form.querySelector("#renew-qr");
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
            // Paying by QR means a UPI payment.
            form.querySelector('[name="method"][value="upi"]').checked = true;
        }
        update(form);
    });
    update(form);
}

function onInput(form, event) {
    const name = event.target.name;
    if (name === "plan_id") {
        const plan = sheet.plans.find((item) => item.id === event.target.value);
        if (plan) {
            form.elements.fee.value = plan.price;
            if (!sheet.touched.paid) form.elements.paid.value = plan.price;
        }
        sheet.quiet = false;
    } else if (name === "fee") {
        if (!sheet.touched.paid) form.elements.paid.value = form.elements.fee.value;
    } else if (name === "paid") {
        sheet.touched.paid = true;
    }
    sheet.quiet = false;
    sheet.serverError = "";
    update(form);
}

function showSuccess(result) {
    const { body, footer } = modalParts();
    if (!body) return;
    const { membership, payment, balance } = result;
    const member = getMember(sheet.memberId);
    body.innerHTML = `<div class="renew-success" role="status">
        <span class="renew-tick" aria-hidden="true">✓</span>
        <h3>${escapeHTML(member?.name || "Member")} is renewed</h3>
        <p><strong>${escapeHTML(membership.plan_name)}</strong><br>${escapeHTML(formatDate(membership.start_date))} → ${escapeHTML(formatDate(membership.end_date))}</p>
        <p class="helper-text">${payment ? `${escapeHTML(formatINR(payment.amount))} received · receipt ${escapeHTML(payment.receipt_number)}` : "No payment recorded."}${Number(balance.outstanding) > 0 ? ` · balance due ${escapeHTML(formatINR(balance.outstanding))}` : ""}</p>
        ${result.replayed ? `<p class="helper-text">This renewal was already saved, so nothing was added twice.</p>` : ""}
        <p class="helper-text" id="renew-receipt-note" ${payment ? "" : "hidden"}>Getting the receipt ready…</p>
    </div>`;
    footer.innerHTML = `${payment ? `<button class="button button-whatsapp" type="button" data-action="receipt-share" id="renew-receipt-button" disabled>Send receipt on WhatsApp</button>` : ""}<button class="button button-primary" data-action="close-modal" type="button">Done</button>`;
    if (!payment) return;
    const token = sheet.token;
    prepareReceiptShare(payment.id)
        .then(() => {
            if (!isOpen(token)) return;
            document.querySelector("#renew-receipt-button")?.removeAttribute("disabled");
            document.querySelector("#renew-receipt-note")?.setAttribute("hidden", "");
        })
        .catch(() => {
            const note = document.querySelector("#renew-receipt-note");
            if (isOpen(token) && note) note.textContent = "The receipt could not be prepared here. You can send it from Payments.";
        });
}

/** After a saved renewal: the member's plans update at once; onChanged reloads the lists behind the sheet. */
function refreshAfterRenewal(result, { memberId, onChanged }) {
    setMemberCurrentMembership(memberId, result.membership);
    onChanged(result);
    loadMemberMembershipHistory(memberId);
}

function showFormError(form, message) {
    sheet.serverError = message;
    update(form);
}

async function submitRenew(form) {
    if (!sheet || sheet.saving) return;
    const view = currentView(form);
    if (view.blocked) return;
    sheet.quiet = false;
    if (view.errors.length) return update(form);
    const { memberId, key, token, onChanged } = sheet;
    sheet.saving = true;
    sheet.serverError = "";
    const submit = document.querySelector("#renew-submit");
    if (submit) submit.disabled = true;
    update(form);
    try {
        const response = await apiClient.post(`/api/members/${memberId}/renew`, { idempotency_key: key, ...view.request }, { timeoutMs: 30000 });
        const result = response?.data;
        if (!result?.membership) throw new Error("The renewal could not be confirmed.");
        saveUiPreferences({ renewMethod: form.elements.method.value });
        if (isOpen(token)) showSuccess(result);
        toast(`${getMember(memberId)?.name || "Member"} renewed through ${formatDate(result.membership.end_date)}.`);
        refreshAfterRenewal(result, { memberId, onChanged });
    } catch (error) {
        if (!isOpen(token)) return;
        const code = error?.code || "";
        if (error?.isApiError && code === "future_plan") {
            const { body, footer } = modalParts();
            body.innerHTML = `<div class="renew-blocked" role="alert"><p><strong>${escapeHTML(error.message)}</strong></p><p class="helper-text">Nothing was created.</p></div>`;
            footer.innerHTML = cancelFooter;
        } else if (error?.isApiError && code === "dates_changed") {
            toast(error.message, "error");
            openRenewSheet(memberId, { onChanged });
        } else {
            // A retry is safe: the same key is sent again, and a renewal that did go through
            // is returned instead of being made twice.
            const unsure = !error?.isApiError || error.status >= 500;
            showFormError(form, unsure
                ? `${error.message || "No connection."} Nothing is lost: tap the button again, and it will not renew twice.`
                : error.message || "The renewal could not be saved.");
        }
    } finally {
        if (sheet?.token === token) {
            sheet.saving = false;
            const button = document.querySelector("#renew-submit");
            if (button?.isConnected && form.isConnected) update(form);
        }
    }
}

/** Handles the sheet's submit. Returns true when the event was its form. */
export function handleRenewSubmit(event) {
    if (event.target.id !== "renew-form") return false;
    event.preventDefault();
    submitRenew(event.target);
    return true;
}

export { closeModal as closeRenewSheet };
