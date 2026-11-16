// Settings › Renewals and grace (migration 020) and Settings › Plan holds (migration 021). Renewals:
// the gym's default grace period, the welcome-back discount for lapsed and old members, and how long
// lapsed members stay on the Lapsed list. Plan holds: the minimum hold and the optional hold fee.
// Every login sees them; only the owner can change them. Each section is its own form and saves only
// its own fields.
import { apiClient } from "../api/apiClient.js";
import { toast } from "../components/toast.js";
import { escapeHTML } from "../utils.js";

export const renewalSettings = { status: "idle", data: null, message: "" };

export async function loadRenewalSettings() {
    if (renewalSettings.status === "loading") return renewalSettings;
    renewalSettings.status = "loading";
    try {
        renewalSettings.data = (await apiClient.get("/api/gym-settings/renewals"))?.data || null;
        renewalSettings.status = "ready";
        renewalSettings.message = "";
    } catch (error) {
        renewalSettings.status = "error";
        renewalSettings.message = error.message || "Renewal settings could not be loaded.";
    }
    return renewalSettings;
}

// One section: its heading and intro, then (once loaded) a form of fields and one Save button.
function sectionCard({ id, heading, intro, formId, fields, saveLabel }) {
    const head = `<h2>${heading}</h2><p class="helper-text">${intro}</p>`;
    if (renewalSettings.status !== "ready" || !renewalSettings.data) {
        const body = renewalSettings.status === "error"
            ? `<div class="empty-state" role="alert"><p>${escapeHTML(renewalSettings.message)}</p></div>`
            : `<div class="empty-state" role="status">Loading…</div>`;
        return `<section class="card settings-section" id="${id}">${head}${body}</section>`;
    }
    const editable = renewalSettings.data.can_edit === true;
    return `<section class="card settings-section" id="${id}">${head}
        ${editable ? "" : `<div class="note-box" role="note">Only the gym owner can change these settings.</div>`}
        <form id="${formId}" class="form-grid" novalidate>
            <fieldset class="field full plain-fieldset" ${editable ? "" : "disabled"}>${fields(renewalSettings.data)}</fieldset>
            ${editable ? `<div class="field full"><span class="helper-text field-error" id="${formId}-error" role="alert" hidden></span><button class="button button-primary" type="submit">${saveLabel}</button></div>` : ""}
        </form>
    </section>`;
}

export function renderRenewalSettings() {
    return sectionCard({
        id: "renewal-settings",
        heading: "Renewals and grace",
        intro: "Grace lets members check in for a few days after their plan ends, with a warning. After that they are lapsed and asked to renew at the desk. A renewal starts the day after the current plan ends; if the plan has already ended it starts the day you renew, and the gap is not charged.",
        formId: "renewal-settings-form",
        saveLabel: "Save renewal settings",
        fields: (data) => {
            const percent = data.welcome_back_discount_type !== "amount";
            return `<div class="field"><label for="setting-grace">Default grace period (days)</label><input id="setting-grace" name="expiry_grace_days" type="number" min="0" max="60" step="1" inputmode="numeric" value="${Number(data.expiry_grace_days) || 0}"><span class="helper-text">Used by plans that have no grace of their own. Changing it affects new memberships only.</span></div>
                <div class="field"><label for="setting-lapsed-days">Keep lapsed members on the list for (days)</label><input id="setting-lapsed-days" name="lapsed_list_days" type="number" min="7" max="365" step="1" inputmode="numeric" value="${Number(data.lapsed_list_days) || 60}"><span class="helper-text">Counted from the day the plan ended. After that they move to Old members.</span></div>
                <div class="field"><label for="setting-welcome-type">Welcome back discount</label><select id="setting-welcome-type" name="welcome_back_discount_type"><option value="percent" ${percent ? "selected" : ""}>Percent of the price</option><option value="amount" ${percent ? "" : "selected"}>Fixed amount (₹)</option></select></div>
                <div class="field"><label for="setting-welcome-value">Discount value</label><input id="setting-welcome-value" name="welcome_back_discount_value" type="number" min="0" step="1" inputmode="decimal" value="${Number(data.welcome_back_discount_value) || 0}"><span class="helper-text">Offered on the Renew sheet for lapsed and old members. 0 hides the button.</span></div>`;
        }
    });
}

export function renderHoldSettings() {
    return sectionCard({
        id: "hold-settings",
        heading: "Plan holds",
        intro: "Staff can pause a member's plan while they are away; the days left are kept. How long a hold can last, and how many a plan allows, are set on each plan (Plans › Edit), with a default for its length.",
        formId: "hold-settings-form",
        saveLabel: "Save plan hold settings",
        fields: (data) => `<div class="field"><label for="setting-min-hold">Minimum hold (days)</label><input id="setting-min-hold" name="min_hold_days" type="number" min="0" max="365" step="1" inputmode="numeric" value="${Number.isInteger(data.min_hold_days) ? data.min_hold_days : 15}"><span class="helper-text">A planned return date must be at least this many days after the hold starts. Members who come back sooner are never blocked. 0 means no minimum.</span></div>
            <div class="field"><label for="setting-hold-fee">Hold fee</label><select id="setting-hold-fee" name="hold_fee_enabled"><option value="false" ${data.hold_fee_enabled ? "" : "selected"}>No fee</option><option value="true" ${data.hold_fee_enabled ? "selected" : ""}>Charge a fee</option></select></div>
            <div class="field"><label for="setting-hold-fee-amount">Hold fee amount (₹)</label><input id="setting-hold-fee-amount" name="hold_fee_amount" type="number" min="0" step="1" inputmode="decimal" value="${Number(data.hold_fee_amount) || 0}"><span class="helper-text">Recorded as a payment when a hold starts, with a UPI QR if you like. Cancelling the hold the same day marks it refunded.</span></div>`
    });
}

function showError(form, message) {
    const box = form.querySelector(`#${form.id}-error`);
    if (!box) return toast(message, "error");
    box.textContent = message;
    box.hidden = !message;
}

/**
 * What the form sends: only the fields it has (the renewals form and the holds form are separate),
 * checked the same way the server checks them. Returns { body } or { problem }.
 */
export function renewalSettingsBody(form) {
    const values = new FormData(form);
    const body = {};
    const number = (name) => Number(values.get(name));
    if (values.has("expiry_grace_days")) body.expiry_grace_days = number("expiry_grace_days");
    if (values.has("lapsed_list_days")) body.lapsed_list_days = number("lapsed_list_days");
    if (values.has("welcome_back_discount_type")) {
        body.welcome_back_discount_type = String(values.get("welcome_back_discount_type"));
        body.welcome_back_discount_value = number("welcome_back_discount_value");
    }
    if (values.has("min_hold_days")) body.min_hold_days = number("min_hold_days");
    if (values.has("hold_fee_enabled")) {
        body.hold_fee_enabled = values.get("hold_fee_enabled") === "true";
        body.hold_fee_amount = Number(values.get("hold_fee_amount") || 0);
    }
    if ("expiry_grace_days" in body && (!Number.isInteger(body.expiry_grace_days) || body.expiry_grace_days < 0 || body.expiry_grace_days > 60)) return { problem: "Grace must be a whole number of days from 0 to 60." };
    if ("lapsed_list_days" in body && (!Number.isInteger(body.lapsed_list_days) || body.lapsed_list_days < 7 || body.lapsed_list_days > 365)) return { problem: "Keep lapsed members on the list for 7 to 365 days." };
    if ("welcome_back_discount_value" in body) {
        if (!Number.isFinite(body.welcome_back_discount_value) || body.welcome_back_discount_value < 0) return { problem: "Enter the welcome-back discount (0 or more)." };
        if (body.welcome_back_discount_type === "percent" && body.welcome_back_discount_value > 100) return { problem: "A percent discount can be at most 100." };
    }
    if ("min_hold_days" in body && (!Number.isInteger(body.min_hold_days) || body.min_hold_days < 0 || body.min_hold_days > 365)) return { problem: "The minimum hold must be 0 to 365 days (0 means no minimum)." };
    if ("hold_fee_amount" in body) {
        if (!Number.isFinite(body.hold_fee_amount) || body.hold_fee_amount < 0) return { problem: "Enter the hold fee (0 or more)." };
        if (body.hold_fee_enabled && !(body.hold_fee_amount > 0)) return { problem: "Enter a hold fee above 0, or choose No fee." };
    }
    return { body };
}

export async function saveRenewalSettings(form, onChange = () => {}) {
    const { body, problem } = renewalSettingsBody(form);
    if (problem) return showError(form, problem);
    showError(form, "");
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
        renewalSettings.data = (await apiClient.put("/api/gym-settings/renewals", body))?.data || renewalSettings.data;
        toast("Settings saved.");
        onChange();
    } catch (error) {
        showError(form, error.message || "The settings could not be saved.");
    } finally {
        if (submit?.isConnected) submit.disabled = false;
    }
}
