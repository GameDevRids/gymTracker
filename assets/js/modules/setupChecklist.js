// "Get started" on Today for a new gym: six steps, each ticked from the gym's real data. Once three
// are done it shrinks to one line with the next step; it goes when all are done or the owner hides
// it (remembered in this browser, per gym).
import { escapeHTML } from "../utils.js";
import { state } from "../state.js";
import { fetchActivePlans } from "../api/plansApi.js";
import { readUiPreferences, saveUiPreferences } from "../storage.js";

const plans = { status: "idle", count: 0 };

/** Loads how many active plans the gym has, until it has one, then calls onChange. */
export function loadSetupPlans(onChange = () => {}) {
    if (plans.status === "loading" || (plans.status === "ready" && plans.count > 0)) return;
    plans.status = "loading";
    fetchActivePlans()
        .then((list) => { plans.count = list.length; plans.status = "ready"; })
        .catch(() => { plans.status = "error"; })
        .finally(onChange);
}

function hiddenFor() {
    return Array.isArray(readUiPreferences().setupHiddenFor) ? readUiPreferences().setupHiddenFor : [];
}

export function hideSetupChecklist() {
    const gymId = state.gym.id || "";
    if (gymId && !hiddenFor().includes(gymId)) saveUiPreferences({ setupHiddenFor: [...hiddenFor(), gymId].slice(-20) });
}

export function setupSteps(summary) {
    const owner = state.gym.role === "owner";
    return [
        { done: Boolean(state.gym.upiId), title: "Add your UPI ID", detail: "Members pay by scanning a QR with the amount filled in.", view: "settings", tab: "payments", label: "Open Settings" },
        { done: Boolean(String(state.gym.phone || "").trim()), title: "Add your gym's phone number", detail: "Welcome, reminder and enquiry messages end with it, so members can call you.", view: "settings", tab: "details", label: "Add phone" },
        { done: plans.count > 0, title: "Create your membership plans", detail: "For example Monthly ₹1,500 or Quarterly ₹4,000.", view: "plans", label: "Add a plan" },
        {
            done: Number(summary?.total_members || 0) > 0,
            title: owner ? "Add your members" : "Add members",
            detail: owner ? "Import them from your Excel sheet in one go, or add them one by one." : "Add members one by one.",
            action: owner ? "import-csv" : "add-member",
            label: owner ? "Import from Excel" : "Add member"
        },
        { done: Number(summary?.collected_all_time || 0) > 0, title: "Record a payment", detail: "Cash or UPI, with a numbered receipt.", view: "payments", label: "Open Payments" },
        { done: state.attendance.length > 0, title: "Record a check-in", detail: "With member QR cards or the entrance poster (choose in Settings › Attendance).", view: "scan", label: "Open Check-in" }
    ];
}

/** Once this many steps are done, the card shrinks to one line with the next step. */
export const SLIM_AFTER = 3;

const stepTarget = (step) => (step.view ? `data-view="${step.view}"${step.tab ? ` data-tab="${step.tab}"` : ""}` : `data-action="${step.action}"`);

/**
 * How Get started looks for these steps: "hidden" when all are done, "slim" (one line: "1 step left:
 * Add your UPI ID") once 3 are done, otherwise "full".
 */
export function setupMode(steps) {
    const done = steps.filter((step) => step.done).length;
    if (done === steps.length) return "hidden";
    return done >= SLIM_AFTER ? "slim" : "full";
}

/** The card, or "" once every step is done, while plans are still loading, or when hidden. */
export function renderSetupChecklist(summary) {
    if (!summary || plans.status !== "ready" || hiddenFor().includes(state.gym.id || "")) return "";
    const steps = setupSteps(summary);
    const done = steps.filter((step) => step.done).length;
    const mode = setupMode(steps);
    if (mode === "hidden") return "";
    if (mode === "slim") {
        const next = steps.find((step) => !step.done);
        const left = steps.length - done;
        return `<p class="setup-slim" aria-label="Get started"><span><strong>${left} step${left === 1 ? "" : "s"} left:</strong> ${escapeHTML(next.title)}</span><button class="text-button" type="button" ${stepTarget(next)}>${escapeHTML(next.label)} →</button></p>`;
    }
    const items = steps.map((step) => `<li class="setup-step${step.done ? " is-done" : ""}">
        <span class="setup-tick" aria-hidden="true">${step.done ? "✓" : ""}</span>
        <span class="setup-text"><strong>${escapeHTML(step.title)}</strong><small>${escapeHTML(step.detail)}</small></span>
        ${step.done ? `<span class="sr-only">Done</span>` : `<button class="button button-secondary button-small" type="button" ${stepTarget(step)}>${escapeHTML(step.label)}</button>`}
    </li>`).join("");
    return `<section class="card setup-card" aria-labelledby="setup-title">
        <div class="card-header"><div><h2 id="setup-title">Get started</h2><p>${done} of ${steps.length} done</p></div><button class="text-button" type="button" data-action="hide-setup">Hide</button></div>
        <div class="setup-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${done}" aria-label="Setup progress"><span style="width:${Math.round(done / steps.length * 100)}%"></span></div>
        <ol class="setup-list">${items}</ol>
    </section>`;
}
