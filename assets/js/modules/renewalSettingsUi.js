// Settings › Renewals and grace (migration 020): the gym's default grace period, the welcome-back
// discount for lapsed and old members, and how long lapsed members stay on the Lapsed list; and the
// plan hold rules (migration 021): the minimum hold and the optional hold fee.
// Every login sees them; only the owner can change them.
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

export function renderRenewalSettings() {
    const heading = `<h2>Renewals and grace</h2><p class="helper-text">Grace lets members check in for a few days after their plan ends, with a warning. After that they are lapsed and asked to renew at the desk.</p>`;
    if (renewalSettings.status !== "ready" || !renewalSettings.data) {
        const body = renewalSettings.status === "error"
            ? `<div class="empty-state" role="alert"><p>${escapeHTML(renewalSettings.message)}</p></div>`
            : `<div class="empty-state" role="status">Loading renewal settings…</div>`;
        return `<section class="card settings-section" id="renewal-settings">${heading}${body}</section>`;
    }
    const data = renewalSettings.data;
    const editable = data.can_edit === true;
    const percent = data.welcome_back_discount_type !== "amount";
    return `<section class="card settings-section" id="renewal-settings">${heading}
        ${editable ? "" : `<div class="note-box" role="note">Only the gym owner can change these settings.</div>`}
        <form id="renewal-settings-form" class="form-grid" novalidate>
            <fieldset class="field full plain-fieldset" ${editable ? "" : "disabled"}>
                <div class="field"><label for="setting-grace">Default grace period (days)</label><input id="setting-grace" name="expiry_grace_days" type="number" min="0" max="60" step="1" inputmode="numeric" value="${Number(data.expiry_grace_days) || 0}"><span class="helper-text">Used by plans that have no grace of their own. Changing it affects new memberships only.</span></div>
                <div class="field"><label for="setting-lapsed-days">Keep lapsed members on the list for (days)</label><input id="setting-lapsed-days" name="lapsed_list_days" type="number" min="7" max="365" step="1" inputmode="numeric" value="${Number(data.lapsed_list_days) || 60}"><span class="helper-text">Counted from the day the plan ended. After that they move to Old members.</span></div>
                <div class="field"><label for="setting-welcome-type">Welcome back discount</label><select id="setting-welcome-type" name="welcome_back_discount_type"><option value="percent" ${percent ? "selected" : ""}>Percent of the price</option><option value="amount" ${percent ? "" : "selected"}>Fixed amount (₹)</option></select></div>
                <div class="field"><label for="setting-welcome-value">Discount value</label><input id="setting-welcome-value" name="welcome_back_discount_value" type="number" min="0" step="1" inputmode="decimal" value="${Number(data.welcome_back_discount_value) || 0}"><span class="helper-text">Offered on the Renew sheet for lapsed and old members. 0 hides the button.</span></div>
                <div class="field"><label for="setting-min-hold">Minimum hold (days)</label><input id="setting-min-hold" name="min_hold_days" type="number" min="0" max="365" step="1" inputmode="numeric" value="${Number.isInteger(data.min_hold_days) ? data.min_hold_days : 15}"><span class="helper-text">A planned return date must be at least this many days after the hold starts. Members who come back sooner are never blocked. 0 means no minimum.</span></div>
                <div class="field"><label for="setting-hold-fee">Hold fee</label><select id="setting-hold-fee" name="hold_fee_enabled"><option value="false" ${data.hold_fee_enabled ? "" : "selected"}>No fee</option><option value="true" ${data.hold_fee_enabled ? "selected" : ""}>Charge a fee</option></select></div>
                <div class="field"><label for="setting-hold-fee-amount">Hold fee amount (₹)</label><input id="setting-hold-fee-amount" name="hold_fee_amount" type="number" min="0" step="1" inputmode="decimal" value="${Number(data.hold_fee_amount) || 0}"><span class="helper-text">Recorded as a payment when a hold starts, with a UPI QR if you like. Cancelling the hold the same day marks it refunded.</span></div>
            </fieldset>
            ${editable ? `<div class="field full"><span class="helper-text field-error" id="renewal-settings-error" role="alert" hidden></span><button class="button button-primary" type="submit">Save renewal settings</button></div>` : ""}
        </form>
    </section>`;
}

function showError(form, message) {
    const box = form.querySelector("#renewal-settings-error");
    if (!box) return toast(message, "error");
    box.textContent = message;
    box.hidden = !message;
}

export async function saveRenewalSettings(form, onChange = () => {}) {
    const values = new FormData(form);
    const body = {
        expiry_grace_days: Number(values.get("expiry_grace_days")),
        lapsed_list_days: Number(values.get("lapsed_list_days")),
        welcome_back_discount_type: String(values.get("welcome_back_discount_type")),
        welcome_back_discount_value: Number(values.get("welcome_back_discount_value")),
        min_hold_days: Number(values.get("min_hold_days")),
        hold_fee_enabled: values.get("hold_fee_enabled") === "true",
        hold_fee_amount: Number(values.get("hold_fee_amount") || 0)
    };
    if (!Number.isInteger(body.expiry_grace_days) || body.expiry_grace_days < 0 || body.expiry_grace_days > 60) return showError(form, "Grace must be a whole number of days from 0 to 60.");
    if (!Number.isInteger(body.lapsed_list_days) || body.lapsed_list_days < 7 || body.lapsed_list_days > 365) return showError(form, "Keep lapsed members on the list for 7 to 365 days.");
    if (!Number.isFinite(body.welcome_back_discount_value) || body.welcome_back_discount_value < 0) return showError(form, "Enter the welcome-back discount (0 or more).");
    if (body.welcome_back_discount_type === "percent" && body.welcome_back_discount_value > 100) return showError(form, "A percent discount can be at most 100.");
    if (!Number.isInteger(body.min_hold_days) || body.min_hold_days < 0 || body.min_hold_days > 365) return showError(form, "The minimum hold must be 0 to 365 days (0 means no minimum).");
    if (!Number.isFinite(body.hold_fee_amount) || body.hold_fee_amount < 0) return showError(form, "Enter the hold fee (0 or more).");
    if (body.hold_fee_enabled && !(body.hold_fee_amount > 0)) return showError(form, "Enter a hold fee above 0, or choose No fee.");
    showError(form, "");
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
        renewalSettings.data = (await apiClient.put("/api/gym-settings/renewals", body))?.data || renewalSettings.data;
        toast("Renewal settings saved.");
        onChange();
    } catch (error) {
        showError(form, error.message || "The renewal settings could not be saved.");
    } finally {
        if (submit?.isConnected) submit.disabled = false;
    }
}
