// Plan holds: pausing a member's plan while they are away, then continuing the days that were left.
// Staff only (the server checks). From the member profile: "Put plan on hold" (start date, a return
// date or "Until they come back", an optional hold fee with a UPI QR), "Resume plan" and "Cancel
// hold". The profile also lists every hold: dates, days held, fee, who approved it, and the plan's
// end date before and after. The rules are shared with the server (assets/js/holds.js), and the
// database saves each action in one transaction, so a double tap never holds twice.
import { apiClient } from "../api/apiClient.js";
import { openModal, closeModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { escapeHTML, formatDate, formatINR, formatPhone, indiaISODate } from "../utils.js";
import { getMember, state } from "../state.js";
import { getLanguage } from "../i18n.js";
import { welcomePhone } from "../welcomeMessage.js";
import { buildHoldReturnMessage } from "../holdMessage.js";
import { holdDates, holdLimitsText, holdReturnProblem, holdStartProblem, latestReturn } from "../holds.js";
import { dayDiff, plusDays } from "../memberStatus.js";
import { gymUpi, paymentLink, prepareReceiptShare, qrSvg } from "./upiPayments.js";
import { loadMemberMembershipHistory, setMemberCurrentMembership } from "./memberMemberships.js";
import { readUiPreferences, saveUiPreferences } from "../storage.js";

const METHODS = [["upi", "UPI"], ["cash", "Cash"], ["card", "Card"], ["other", "Other"]];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const END_REASONS = {
    return_date: "Came back on the planned date",
    check_in: "Came back and checked in",
    resumed: "Resumed by staff",
    max_days: "Reached the longest hold"
};

// ---------- What the sheet shows, as plain data (no DOM) ----------

/**
 * Everything the "Put plan on hold" sheet needs from its inputs: whether a hold is allowed (and
 * why not), the dates it may use, what the plan's end date becomes, the fee, the button's label,
 * the problems that keep it disabled, and the request to send.
 * eligibility: holdEligibility(...) as the server sent it; membership: the running plan.
 */
export function holdSheetView({ eligibility, membership, today, startsOn = "", returnMode = "date", returnOn = "", method = "cash", utr = "" }) {
    if (!eligibility?.allowed) {
        return { allowed: false, reason: eligibility?.reason || "This plan can't be put on hold.", errors: [eligibility?.reason || "This plan can't be put on hold."], request: null, label: "Put plan on hold" };
    }
    const start = startsOn || today;
    const { limits, minHoldDays, fee } = eligibility;
    const planEnd = membership.end_date;
    const minReturn = plusDays(start, Math.max(Number(minHoldDays) || 0, 1));
    const maxReturn = latestReturn(start, limits.maxHoldDays);
    const errors = [];
    const startProblem = holdStartProblem(start, { today, planEnd });
    if (startProblem) errors.push(startProblem);
    let planned = null;
    if (returnMode === "date") {
        if (!returnOn) errors.push("Choose the return date, or pick Until they come back.");
        else if (!startProblem) {
            const problem = holdReturnProblem(start, returnOn, { minHoldDays, maxHoldDays: limits.maxHoldDays });
            if (problem) errors.push(problem);
        }
        planned = returnOn || null;
    }
    const remainingDays = startProblem ? 0 : dayDiff(start, planEnd) + 1;
    const utrDigits = String(utr || "").replace(/\s+/g, "");
    if (fee > 0 && method === "upi" && utrDigits && !/^\d{12}$/.test(utrDigits)) errors.push("A UPI reference (UTR) is 12 digits.");
    let preview = "";
    if (!startProblem) {
        if (returnMode === "date" && returnOn && !errors.length) {
            const dates = holdDates({ endBefore: planEnd, startsOn: start, resumeOn: returnOn });
            preview = `Back on ${formatDate(returnOn)}: the plan ends on ${formatDate(dates.endAfter)} (${dates.daysHeld} days held).`;
        } else if (returnMode === "open") {
            preview = `${remainingDays} days stay kept for the member. When they come back the plan ends ${remainingDays} days later (the day they return counts). The hold ends by itself after ${limits.maxHoldDays} days, on ${formatDate(maxReturn)}.`;
        }
        if (start > today) preview = `Starts on ${formatDate(start)}; until then the plan keeps running. ${preview}`.trim();
    }
    const request = errors.length ? null : {
        starts_on: start,
        planned_return_on: planned,
        ...(fee > 0 ? { method, ...(method === "upi" && utrDigits ? { upi_reference: utrDigits } : {}) } : {})
    };
    return {
        allowed: true,
        reason: "",
        startsOn: start,
        minStart: today,
        maxStart: planEnd,
        minReturn,
        maxReturn,
        remainingDays,
        fee,
        preview,
        errors,
        request,
        label: fee > 0 ? `Put on hold and record ${formatINR(fee)}` : "Put plan on hold"
    };
}

/** What resuming today does: days held, the plan's new end date, and the grace after it. */
export function resumeView({ hold, today, graceDays = 0 }) {
    const dates = holdDates({ endBefore: hold.end_before, startsOn: hold.starts_on, resumeOn: today > hold.starts_on ? today : hold.starts_on });
    return { daysHeld: dates.daysHeld, newEnd: dates.endAfter, graceUntil: graceDays > 0 ? plusDays(dates.endAfter, graceDays) : "", graceDays };
}

// ---------- A member's holds on the profile ----------

const cache = new Map(); // memberId → { status: "loading" | "ready" | "error", data, message }

export function loadMemberHolds(memberId, onChange = () => {}) {
    if (!UUID.test(String(memberId || ""))) return Promise.resolve();
    const previous = cache.get(memberId);
    cache.set(memberId, { status: "loading", data: previous?.data || null, message: "" });
    return apiClient.get(`/api/members/${memberId}/holds`)
        .then((response) => cache.set(memberId, { status: "ready", data: response?.data || null, message: "" }))
        .catch((error) => cache.set(memberId, { status: "error", data: null, message: error?.message || "Holds could not be loaded." }))
        .then(() => onChange());
}

function person(entry) {
    if (!entry) return "";
    return entry.email ? `${entry.role} (${entry.email})` : entry.role;
}

function holdRow(hold) {
    const ended = hold.ended_on ? formatDate(hold.ended_on) : "";
    const until = hold.cancelled ? "cancelled" : ended || (hold.planned_return_on ? `back by ${formatDate(hold.planned_return_on)}` : "until they come back");
    const tag = hold.cancelled ? `<span class="status status-inactive">Cancelled</span>` : hold.ended_on ? `<span class="status status-active">Ended</span>` : `<span class="status status-on_hold">On hold</span>`;
    const lines = [];
    if (hold.ended_on) lines.push(`${Number(hold.days_held)} day${Number(hold.days_held) === 1 ? "" : "s"} held · plan end ${formatDate(hold.end_before)} → ${formatDate(hold.end_after)}`);
    else if (!hold.cancelled) lines.push(`${Number(hold.remaining_days)} days of the plan are kept · it was to end ${formatDate(hold.end_before)}`);
    if (hold.ended_on && END_REASONS[hold.end_reason]) lines.push(END_REASONS[hold.end_reason]);
    if (hold.fee_amount > 0) {
        const payment = hold.fee_payment;
        lines.push(`Hold fee ${formatINR(hold.fee_amount)}${payment?.receipt_number ? ` · receipt ${payment.receipt_number}` : ""}${payment?.refunded_at ? " · refunded" : ""}`);
    }
    if (hold.approved_by_name) lines.push(`Approved by ${person(hold.approved_by_name)}`);
    return `<div class="activity-row hold-row"><span class="activity-dot"></span><span><p><strong>${escapeHTML(formatDate(hold.starts_on))} → ${escapeHTML(until)}</strong> ${tag}</p>${lines.map((line) => `<small>${escapeHTML(line)}</small>`).join("")}</span></div>`;
}

/** "On hold since 4 Mar" / "On hold until 20 Mar", for lists and the profile. */
export function holdNote(detail) {
    const hold = detail?.hold;
    if (!hold) return "";
    return hold.planned_return_on ? `On hold until ${formatDate(hold.planned_return_on)}` : `On hold since ${formatDate(hold.starts_on)}`;
}

/** The profile's "Plan hold" section: what is happening now, the buttons, and every past hold. */
export function renderHoldSection(member) {
    const entry = cache.get(member.id);
    const id = escapeHTML(member.id);
    let body;
    if (!entry || (entry.status === "loading" && !entry.data)) body = `<div class="empty-state" role="status">Loading holds…</div>`;
    else if (entry.status === "error") body = `<div class="empty-state" role="alert"><p>${escapeHTML(entry.message)}</p><button class="button button-secondary" type="button" data-action="hold-retry" data-id="${id}">Try again</button></div>`;
    else {
        const data = entry.data;
        const today = indiaISODate();
        let now;
        if (data.hold) {
            const hold = data.hold;
            const cancellable = hold.starts_on >= today;
            now = `<div class="card-body hold-now"><p><strong>On hold since ${escapeHTML(formatDate(hold.starts_on))}</strong>${hold.planned_return_on ? ` · back by ${escapeHTML(formatDate(hold.planned_return_on))}` : " · until they come back"}</p><p class="helper-text">Before the hold the plan was to end ${escapeHTML(formatDate(hold.end_before))}. Resumed today, it would end ${escapeHTML(formatDate(hold.end_if_resumed_today))}.</p><div class="hold-actions"><button class="button button-primary" type="button" data-action="hold-resume" data-id="${id}" data-hold="${escapeHTML(hold.id)}">Resume plan</button>${cancellable ? `<button class="button button-secondary" type="button" data-action="hold-cancel" data-id="${id}" data-hold="${escapeHTML(hold.id)}">Cancel hold</button>` : ""}</div></div>`;
        } else if (data.scheduled_hold) {
            const hold = data.scheduled_hold;
            now = `<div class="card-body hold-now"><p><strong>Hold starts ${escapeHTML(formatDate(hold.starts_on))}</strong>${hold.planned_return_on ? ` · back by ${escapeHTML(formatDate(hold.planned_return_on))}` : " · until they come back"}</p><div class="hold-actions"><button class="button button-secondary" type="button" data-action="hold-cancel" data-id="${id}" data-hold="${escapeHTML(hold.id)}">Cancel hold</button></div></div>`;
        } else {
            const e = data.eligibility;
            const allowed = e.allowed;
            const summary = allowed
                ? `${e.left} of ${e.limits.maxHolds} hold${e.limits.maxHolds === 1 ? "" : "s"} left · up to ${e.limits.maxHoldDays} days each${e.fee > 0 ? ` · hold fee ${formatINR(e.fee)}` : ""}`
                : e.reason;
            now = `<div class="card-body hold-now"><p class="${allowed ? "helper-text" : "helper-text hold-reason"}" id="hold-reason-${id}">${escapeHTML(summary)}</p><div class="hold-actions"><button class="button button-secondary" type="button" data-action="hold-start" data-id="${id}" ${allowed ? "" : `disabled aria-describedby="hold-reason-${id}"`}>Put plan on hold</button></div></div>`;
        }
        const holds = data.holds || [];
        body = `${now}<div class="activity-list">${holds.length ? holds.map(holdRow).join("") : `<div class="empty-state">No holds yet.</div>`}</div>`;
    }
    return `<section class="card profile-section" id="member-holds"><div class="card-header"><div><h2>Plan hold</h2><p>Pause the plan while the member is away, then continue the days that were left</p></div></div>${body}</section>`;
}

// ---------- The sheets ----------

let sheet = null; // { token, memberId, data, key, today, onChanged, saving, serverError }
let tokenCounter = 0;

function newKey() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16).padStart(12, "0")}-0000-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, "0").slice(0, 12)}`;
}

function modalParts() {
    const modal = document.querySelector("#modal-root .modal");
    return { modal, body: modal?.querySelector(".modal-body"), footer: modal?.querySelector(".modal-footer") };
}

function isOpen(token) {
    return sheet?.token === token && Boolean(document.querySelector("#modal-root .hold-sheet"));
}

const closeFooter = `<button class="button button-secondary" data-action="close-modal" type="button">Close</button>`;

function rememberedMethod() {
    const saved = readUiPreferences().renewMethod;
    return METHODS.some(([value]) => value === saved) ? saved : "cash";
}

async function fetchHolds(memberId) {
    const response = await apiClient.get(`/api/members/${memberId}/holds`);
    if (!response?.data) throw new Error("The holds could not be loaded.");
    cache.set(memberId, { status: "ready", data: response.data, message: "" });
    return response.data;
}

function openSheet({ title, memberId, onChanged }) {
    const token = ++tokenCounter;
    sheet = { token, memberId, data: null, key: newKey(), today: indiaISODate(), onChanged, saving: false, serverError: "" };
    openModal({ title, subtitle: "", body: `<div class="empty-state" role="status">Loading…</div>`, footer: closeFooter });
    document.querySelector("#modal-root .modal")?.classList.add("renew-sheet", "hold-sheet");
    return token;
}

function showLoadError(token, error, retry) {
    if (!isOpen(token)) return;
    const { body } = modalParts();
    body.innerHTML = `<div class="empty-state" role="alert"><p>${escapeHTML(error?.message || "This could not be loaded.")}</p><button class="button button-secondary" type="button" data-hold-retry>Try again</button></div>`;
    body.querySelector("[data-hold-retry]").addEventListener("click", retry);
}

// ----- Put plan on hold -----

export async function openHoldSheet(memberId, { onChanged = () => {} } = {}) {
    const member = getMember(memberId);
    if (!member || !UUID.test(memberId)) return toast("This member could not be found. Refresh the page and try again.", "error");
    const token = openSheet({ title: `Put ${escapeHTML(member.name)}'s plan on hold`, memberId, onChanged });
    try {
        sheet.data = await fetchHolds(memberId);
        if (!isOpen(token)) return;
        sheet.today = indiaISODate();
        showHoldForm();
    } catch (error) {
        showLoadError(token, error, () => openHoldSheet(memberId, { onChanged }));
    }
}

function renderHoldForm(view) {
    const methods = METHODS.map(([value, label]) => `<label class="renew-method"><input type="radio" name="method" value="${value}" ${value === rememberedMethod() ? "checked" : ""}><span>${label}</span></label>`).join("");
    const membership = sheet.data.membership;
    const fee = sheet.data.eligibility.fee;
    return `<form id="hold-form" class="renew-form" novalidate>
        <div class="renew-dates"><span>${escapeHTML(membership.plan_name)}</span><strong>${escapeHTML(formatDate(membership.start_date))} → ${escapeHTML(formatDate(membership.end_date))}</strong><small>${escapeHTML(holdLimitsText(sheet.data.eligibility.limits))} on this plan · ${sheet.data.eligibility.left} hold${sheet.data.eligibility.left === 1 ? "" : "s"} left · back at least ${sheet.data.eligibility.minHoldDays > 0 ? sheet.data.eligibility.minHoldDays : 1} days later</small></div>
        <div class="field"><label for="hold-start">Hold starts</label><input id="hold-start" name="starts_on" type="date" min="${escapeHTML(view.minStart)}" max="${escapeHTML(view.maxStart)}" value="${escapeHTML(sheet.today)}"></div>
        <fieldset class="hold-return"><legend>Back on</legend>
            <label class="hold-choice"><input type="radio" name="return_mode" value="date" checked><span>A return date</span></label>
            <div class="field" id="hold-return-field"><input id="hold-return" name="return_on" type="date" aria-label="Return date"></div>
            <label class="hold-choice"><input type="radio" name="return_mode" value="open"><span>Until they come back</span></label>
        </fieldset>
        <p class="renew-balance" id="hold-preview" aria-live="polite"></p>
        ${fee > 0 ? `<fieldset class="renew-payment"><legend>Hold fee ${escapeHTML(formatINR(fee))}</legend>
            <div class="renew-methods" role="radiogroup" aria-label="Payment method">${methods}</div>
            <div class="field" id="hold-utr-field" hidden><label for="hold-utr">UPI reference (UTR, optional)</label><input id="hold-utr" name="utr" inputmode="numeric" maxlength="14" autocomplete="off"></div>
            <button class="button button-secondary" type="button" data-hold-sheet="qr" id="hold-qr-button">Show UPI QR</button>
            <div class="renew-qr" id="hold-qr" hidden></div>
        </fieldset>` : ""}
        <p class="helper-text field-error" id="hold-error" role="alert" hidden></p>
    </form>`;
}

function readHoldFields(form) {
    return {
        startsOn: form.elements.starts_on.value,
        returnMode: form.elements.return_mode.value,
        returnOn: form.elements.return_on.value,
        method: form.elements.method?.value || "cash",
        utr: form.elements.utr?.value || ""
    };
}

function currentHoldView(form) {
    return holdSheetView({ eligibility: sheet.data.eligibility, membership: sheet.data.membership, today: sheet.today, ...readHoldFields(form) });
}

function showHoldForm() {
    const { body, footer } = modalParts();
    if (!body) return;
    const base = holdSheetView({ eligibility: sheet.data.eligibility, membership: sheet.data.membership, today: sheet.today });
    if (!base.allowed) {
        body.innerHTML = `<div class="renew-blocked" role="alert"><p><strong>${escapeHTML(base.reason)}</strong></p><p class="helper-text">Nothing was changed.</p></div>`;
        footer.innerHTML = closeFooter;
        return;
    }
    body.innerHTML = renderHoldForm(base);
    footer.innerHTML = `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button button-primary" type="submit" form="hold-form" id="hold-submit">Put plan on hold</button>`;
    const form = body.querySelector("#hold-form");
    sheet.quiet = true;
    form.addEventListener("input", () => { sheet.quiet = false; sheet.serverError = ""; updateHoldForm(form); });
    form.addEventListener("change", () => { sheet.serverError = ""; updateHoldForm(form); });
    form.addEventListener("click", (event) => {
        if (event.target.closest('[data-hold-sheet="qr"]')) {
            const panel = form.querySelector("#hold-qr");
            panel.hidden = !panel.hidden;
            if (!panel.hidden) form.querySelector('[name="method"][value="upi"]').checked = true;
            updateHoldForm(form);
        }
    });
    updateHoldForm(form);
}

function updateHoldForm(form) {
    const view = currentHoldView(form);
    const open = form.elements.return_mode.value === "open";
    form.querySelector("#hold-return-field").hidden = open;
    if (!open) {
        form.elements.return_on.min = view.minReturn || "";
        form.elements.return_on.max = view.maxReturn || "";
    }
    form.querySelector("#hold-preview").textContent = view.preview || "";
    const utrField = form.querySelector("#hold-utr-field");
    if (utrField) utrField.hidden = form.elements.method.value !== "upi";
    const problem = form.querySelector("#hold-error");
    const message = (!sheet.quiet && view.errors[0]) || sheet.serverError || "";
    problem.textContent = message;
    problem.hidden = !message;
    const submit = document.querySelector("#hold-submit");
    if (submit) {
        submit.textContent = view.label;
        submit.disabled = sheet.saving || Boolean(view.errors.length);
    }
    const panel = form.querySelector("#hold-qr");
    const button = form.querySelector("#hold-qr-button");
    if (panel && button) {
        const upi = gymUpi();
        button.disabled = !upi;
        button.textContent = panel.hidden ? "Show UPI QR" : "Hide UPI QR";
        if (!upi) button.title = "Add your UPI ID in Settings first";
        else if (!panel.hidden) {
            const member = getMember(sheet.memberId);
            const { link, message: qrMessage } = paymentLink({ amount: view.fee, memberCode: member?.memberCode || "", planName: sheet.data.membership.plan_name });
            panel.innerHTML = link
                ? `${qrSvg(link, "UPI payment QR code")}<p class="helper-text">Scan with any UPI app to pay <strong>${escapeHTML(formatINR(view.fee))}</strong> to ${escapeHTML(upi.upiId)}. Save the hold once the payment arrives.</p>`
                : `<p class="helper-text" role="alert">${escapeHTML(qrMessage || "The QR could not be made.")}</p>`;
        }
    }
}

function showHoldSuccess(result) {
    const { body, footer } = modalParts();
    if (!body) return;
    const member = getMember(sheet.memberId);
    const hold = result.hold;
    const payment = result.payment;
    body.innerHTML = `<div class="renew-success" role="status">
        <span class="renew-tick" aria-hidden="true">✓</span>
        <h3>${escapeHTML(member?.name || "Member")}'s plan is ${hold.starts_on > sheet.today ? "booked on hold" : "on hold"}</h3>
        <p><strong>From ${escapeHTML(formatDate(hold.starts_on))}</strong><br>${hold.planned_return_on ? `Back by ${escapeHTML(formatDate(hold.planned_return_on))}` : "Until they come back"}</p>
        <p class="helper-text">${Number(hold.remaining_days)} days of the plan are kept.${payment ? ` Hold fee ${escapeHTML(formatINR(payment.amount))} received · receipt ${escapeHTML(payment.receipt_number)}.` : ""}</p>
        ${result.replayed ? `<p class="helper-text">This hold was already saved, so nothing was added twice.</p>` : ""}
        <p class="helper-text" id="hold-receipt-note" ${payment ? "" : "hidden"}>Getting the receipt ready…</p>
    </div>`;
    footer.innerHTML = `${payment ? `<button class="button button-whatsapp" type="button" data-action="receipt-share" id="hold-receipt-button" disabled>Send receipt on WhatsApp</button>` : ""}<button class="button button-primary" data-action="close-modal" type="button">Done</button>`;
    if (!payment) return;
    const token = sheet.token;
    prepareReceiptShare(payment.id)
        .then(() => {
            if (!isOpen(token)) return;
            document.querySelector("#hold-receipt-button")?.removeAttribute("disabled");
            document.querySelector("#hold-receipt-note")?.setAttribute("hidden", "");
        })
        .catch(() => {
            const note = document.querySelector("#hold-receipt-note");
            if (isOpen(token) && note) note.textContent = "The receipt could not be prepared here. You can send it from Payments.";
        });
}

async function submitHold(form) {
    if (!sheet || sheet.saving) return;
    const view = currentHoldView(form);
    sheet.quiet = false;
    if (view.errors.length) return updateHoldForm(form);
    const { memberId, key, token, onChanged } = sheet;
    sheet.saving = true;
    sheet.serverError = "";
    updateHoldForm(form);
    try {
        const response = await apiClient.post(`/api/members/${memberId}/holds`, { idempotency_key: key, ...view.request }, { timeoutMs: 30000 });
        const result = response?.data;
        if (!result?.hold) throw new Error("The hold could not be confirmed.");
        if (view.fee > 0) saveUiPreferences({ renewMethod: form.elements.method.value });
        if (isOpen(token)) showHoldSuccess(result);
        toast(`Plan on hold: ${getMember(memberId)?.name || "Member"}, from ${formatDate(result.hold.starts_on)}.`);
        afterChange(memberId, result, onChanged);
    } catch (error) {
        if (!isOpen(token)) return;
        // A retry is safe: the same key is sent again, and a hold that did go through is returned instead of made twice.
        const unsure = !error?.isApiError || error.status >= 500;
        sheet.serverError = unsure
            ? `${error.message || "No connection."} Nothing is lost: tap the button again, and it will not hold twice.`
            : error.message || "The hold could not be saved.";
    } finally {
        if (sheet?.token === token) {
            sheet.saving = false;
            if (form.isConnected) updateHoldForm(form);
        }
    }
}

/** Handles the sheet's submit. Returns true when the event was its form. */
export function handleHoldSubmit(event) {
    if (event.target.id !== "hold-form") return false;
    event.preventDefault();
    submitHold(event.target);
    return true;
}

function afterChange(memberId, result, onChanged) {
    if (result.membership) setMemberCurrentMembership(memberId, result.membership);
    loadMemberMembershipHistory(memberId);
    fetchHolds(memberId).catch(() => {}).then(() => onChanged(result));
}

// ----- Resume plan -----

export async function openResumeSheet(memberId, holdId, { onChanged = () => {} } = {}) {
    const member = getMember(memberId);
    if (!member || !UUID.test(memberId)) return toast("This member could not be found. Refresh the page and try again.", "error");
    const token = openSheet({ title: `Resume ${escapeHTML(member.name)}'s plan`, memberId, onChanged });
    try {
        sheet.data = await fetchHolds(memberId);
        if (!isOpen(token)) return;
        sheet.today = indiaISODate();
        const hold = sheet.data.hold;
        const { body, footer } = modalParts();
        if (!hold || hold.id !== holdId) {
            body.innerHTML = `<div class="renew-blocked" role="alert"><p><strong>This plan is not on hold any more.</strong></p></div>`;
            footer.innerHTML = closeFooter;
            return;
        }
        const view = resumeView({ hold, today: sheet.today, graceDays: Number(sheet.data.membership?.grace_days) || 0 });
        body.innerHTML = `<div class="renew-dates"><span>If resumed today</span><strong>Plan ends ${escapeHTML(formatDate(view.newEnd))}</strong><small>${view.daysHeld} day${view.daysHeld === 1 ? "" : "s"} held since ${escapeHTML(formatDate(hold.starts_on))}${view.graceUntil ? ` · grace till ${escapeHTML(formatDate(view.graceUntil))}` : ""}. Before the hold it was to end ${escapeHTML(formatDate(hold.end_before))}.</small></div><p class="helper-text field-error" id="hold-error" role="alert" hidden></p>`;
        footer.innerHTML = `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button button-primary" type="button" id="hold-resume-submit">Resume plan</button>`;
        document.querySelector("#hold-resume-submit").addEventListener("click", () => submitHoldAction("resume", holdId));
    } catch (error) {
        showLoadError(token, error, () => openResumeSheet(memberId, holdId, { onChanged }));
    }
}

// ----- Cancel hold -----

export async function openCancelHoldSheet(memberId, holdId, { onChanged = () => {} } = {}) {
    const member = getMember(memberId);
    if (!member || !UUID.test(memberId)) return toast("This member could not be found. Refresh the page and try again.", "error");
    const token = openSheet({ title: "Cancel this hold?", memberId, onChanged });
    try {
        sheet.data = await fetchHolds(memberId);
        if (!isOpen(token)) return;
        const hold = [sheet.data.hold, sheet.data.scheduled_hold].find((item) => item?.id === holdId);
        const full = (sheet.data.holds || []).find((item) => item.id === holdId);
        const { body, footer } = modalParts();
        if (!hold) {
            body.innerHTML = `<div class="renew-blocked" role="alert"><p><strong>This hold is not active any more.</strong></p></div>`;
            footer.innerHTML = closeFooter;
            return;
        }
        const fee = full?.fee_amount > 0 ? `<p>The hold fee of <strong>${escapeHTML(formatINR(full.fee_amount))}</strong> will be marked refunded. Please give it back to the member.</p>` : "";
        body.innerHTML = `<div class="confirm-copy"><p>This undoes the hold completely, as if it never happened. ${escapeHTML(member.name)}'s plan keeps its end date of ${escapeHTML(formatDate(hold.end_before))}, and the hold does not count as used.</p>${fee}</div><p class="helper-text field-error" id="hold-error" role="alert" hidden></p>`;
        footer.innerHTML = `<button class="button button-secondary" data-action="close-modal" type="button">Keep the hold</button><button class="button button-danger" type="button" id="hold-cancel-submit">Cancel hold</button>`;
        document.querySelector("#hold-cancel-submit").addEventListener("click", () => submitHoldAction("cancel", holdId));
    } catch (error) {
        showLoadError(token, error, () => openCancelHoldSheet(memberId, holdId, { onChanged }));
    }
}

/** The welcome back link: only for a member who agreed to WhatsApp messages, with the new end date in it. */
function welcomeBackAction(member, result) {
    if (member?.whatsappOptIn !== true) return `<p class="helper-text reminder-blocked">No WhatsApp consent</p>`;
    const phone = welcomePhone(member.phone);
    if (!phone) return `<p class="helper-text reminder-blocked">No valid mobile number</p>`;
    const membership = result.membership;
    const grace = Number(membership.grace_days) > 0 ? formatDate(plusDays(membership.end_date, Number(membership.grace_days))) : "";
    const text = buildHoldReturnMessage({
        language: getLanguage(),
        name: member.name,
        plan: membership.plan_name,
        endDate: formatDate(membership.end_date),
        graceDate: grace,
        gymName: state.gym.name,
        gymPhone: state.gym.phone ? formatPhone(state.gym.phone) || state.gym.phone : ""
    });
    sheet.message = text;
    return `<a class="button button-whatsapp" href="https://wa.me/91${phone}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener noreferrer" data-hold-message>Send welcome back message</a>`;
}

function showResumeSuccess(result) {
    const { body, footer } = modalParts();
    if (!body) return;
    const member = getMember(sheet.memberId);
    const membership = result.membership;
    const grace = Number(membership.grace_days) > 0 ? ` (grace till ${formatDate(plusDays(membership.end_date, Number(membership.grace_days)))})` : "";
    body.innerHTML = `<div class="renew-success" role="status">
        <span class="renew-tick" aria-hidden="true">✓</span>
        <h3>${escapeHTML(member?.name || "Member")}'s plan is running again</h3>
        <p><strong>${escapeHTML(membership.plan_name)}</strong><br>Now ends ${escapeHTML(formatDate(membership.end_date))}${escapeHTML(grace)}</p>
        <p class="helper-text">${Number(result.hold.days_held)} day${Number(result.hold.days_held) === 1 ? "" : "s"} held${result.replayed ? " · this hold had already ended, so nothing was changed again" : ""}.</p>
    </div>`;
    footer.innerHTML = `${welcomeBackAction(member, result)}<button class="button button-primary" data-action="close-modal" type="button">Done</button>`;
    footer.querySelector("[data-hold-message]")?.addEventListener("click", () => logWelcomeBack(sheet.memberId, sheet.message));
}

async function logWelcomeBack(memberId, text) {
    try {
        await apiClient.post(`/api/members/${memberId}/whatsapp-messages`, { reminder_type: "hold_return", language: getLanguage(), body: text });
    } catch (error) {
        toast(`WhatsApp opened, but the message was not added to the history: ${error.message || "please try again"}`, "error");
    }
}

async function submitHoldAction(kind, holdId) {
    if (!sheet || sheet.saving) return;
    const { memberId, token, onChanged } = sheet;
    sheet.saving = true;
    const button = document.querySelector(kind === "resume" ? "#hold-resume-submit" : "#hold-cancel-submit");
    if (button) button.disabled = true;
    try {
        const response = await apiClient.post(`/api/members/${memberId}/holds/${holdId}/${kind}`, {}, { timeoutMs: 30000 });
        const result = response?.data;
        if (!result?.hold) throw new Error("The change could not be confirmed.");
        if (isOpen(token)) {
            if (kind === "resume") showResumeSuccess(result);
            else {
                const { body, footer } = modalParts();
                body.innerHTML = `<div class="renew-success" role="status"><span class="renew-tick" aria-hidden="true">✓</span><h3>Hold cancelled</h3><p class="helper-text">It is as if it never happened.${result.payment?.refunded_at ? ` The hold fee of ${escapeHTML(formatINR(result.payment.amount))} is marked refunded.` : ""}</p></div>`;
                footer.innerHTML = `<button class="button button-primary" data-action="close-modal" type="button">Done</button>`;
            }
        }
        toast(kind === "resume" ? `Plan resumed: ${getMember(memberId)?.name || "Member"}, valid till ${formatDate(result.membership.end_date)}.` : `Hold cancelled: ${getMember(memberId)?.name || "Member"}.`);
        afterChange(memberId, result, onChanged);
    } catch (error) {
        if (isOpen(token)) {
            const problem = document.querySelector("#hold-error");
            if (problem) {
                problem.textContent = !error?.isApiError || error.status >= 500
                    ? `${error.message || "No connection."} Nothing is lost: try again, and it will not happen twice.`
                    : error.message || "This could not be saved.";
                problem.hidden = false;
            }
            if (button?.isConnected) button.disabled = false;
        }
    } finally {
        if (sheet?.token === token) sheet.saving = false;
    }
}

/** Handles the buttons of the Plan hold section. Returns true when the action was one of them. */
export function handleHoldAction(action, target, onChanged) {
    const id = target.dataset.id || "";
    switch (action) {
        case "hold-start": openHoldSheet(id, { onChanged }); return true;
        case "hold-resume": openResumeSheet(id, target.dataset.hold || "", { onChanged }); return true;
        case "hold-cancel": openCancelHoldSheet(id, target.dataset.hold || "", { onChanged }); return true;
        case "hold-retry": loadMemberHolds(id, onChanged); return true;
        default: return false;
    }
}

export { closeModal as closeHoldSheet };
