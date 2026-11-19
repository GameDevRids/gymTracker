// Enquiries: people who visited and might join (migration 024). The page (tabs, this month's numbers,
// a card per enquiry), adding one at the desk in a few seconds, the visitor's own WhatsApp consent on
// the staff phone, the follow-up message, and Join now. The rules are shared with the server
// (assets/js/enquiries.js).
import { apiClient } from "../api/apiClient.js";
import { fetchActivePlans } from "../api/plansApi.js";
import { openModal, closeModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { emptyState } from "../components/tables.js";
import { escapeHTML, formatDate, formatPhone, indiaISODate } from "../utils.js";
import { state } from "../state.js";
import { renderSkeletonList } from "../components/skeleton.js";
import {
    ENQUIRY_KEEP_DAYS, ENQUIRY_SOURCES, ENQUIRY_STAGES, ENQUIRY_TABS, buildEnquiryMessage, cleanEnquiryPhone,
    enquiriesOnTab, followUpChoices, followUpState, isOpen, last10, monthStats, sourceLabel, tabCounts
} from "../enquiries.js";
import { enquiryTemplate } from "./enquiryTemplateUi.js";

const TAB_LABELS = { today: "Follow up today", open: "All open", joined: "Joined", not_interested: "Not interested" };

// { status: "idle" | "loading" | "ready" | "error", list, today, message, loaded }
export const enquiries = { status: "idle", list: [], today: "", message: "", loaded: false };
let currentTab = "today";
let request = 0;

export function enquiryTab() {
    return currentTab;
}

export function setEnquiryTab(tab) {
    if (ENQUIRY_TABS.includes(tab)) currentTab = tab;
}

/** Follow-ups due today or overdue, once the list has loaded (null before). */
export function dueEnquiries() {
    return enquiries.loaded ? tabCounts(enquiries.list, enquiries.today || indiaISODate()).today : null;
}

/** Loads every enquiry (the server first deletes the ones past 90 days). A reload keeps the list on screen. */
export async function loadEnquiries(onChange = () => {}) {
    const mine = ++request;
    if (!enquiries.loaded) {
        enquiries.status = "loading";
        onChange();
    }
    try {
        const response = await apiClient.get("/api/enquiries");
        if (mine !== request) return;
        Object.assign(enquiries, { status: "ready", list: response?.data?.enquiries || [], today: response?.data?.today || indiaISODate(), message: "", loaded: true });
    } catch (error) {
        if (mine !== request) return;
        if (!enquiries.loaded) Object.assign(enquiries, { status: "error", message: error.message || "Enquiries could not be loaded." });
    }
    onChange();
}

function store(row) {
    if (!row?.id) return;
    enquiries.list = [row, ...enquiries.list.filter((item) => item.id !== row.id)];
}

const find = (id) => enquiries.list.find((item) => item.id === id);
const today = () => enquiries.today || indiaISODate();

// ---------- The page ----------

function followUpBadge(enquiry) {
    const when = followUpState(enquiry, today());
    if (when === "overdue") return `<span class="badge-soft expiry-overdue">Overdue · ${escapeHTML(formatDate(enquiry.follow_up_on))}</span>`;
    if (when === "today") return `<span class="badge-soft">Follow up today</span>`;
    if (when === "later") return `<span class="badge-soft badge-quiet">Follow up ${escapeHTML(formatDate(enquiry.follow_up_on))}</span>`;
    if (enquiry.stage === "joined") return `<span class="status status-active">Joined</span>`;
    if (enquiry.stage === "not_interested") return `<span class="status status-inactive">Not interested</span>`;
    return `<span class="badge-soft badge-quiet">No follow-up date</span>`;
}

/** The WhatsApp link for an enquiry, or why there is none. */
export function enquiryWhatsApp(enquiry) {
    if (enquiry.whatsapp_consent !== true) return { blocked: "No WhatsApp consent" };
    const digits = last10(enquiry.phone);
    const text = buildEnquiryMessage(enquiryTemplate(), {
        name: enquiry.full_name,
        gymName: state.gym.name,
        gymPhone: state.gym.phone ? formatPhone(state.gym.phone) || state.gym.phone : ""
    });
    return { link: `https://wa.me/91${digits}?text=${encodeURIComponent(text)}` };
}

function menu(enquiry) {
    const id = escapeHTML(enquiry.id);
    const items = [];
    if (isOpen(enquiry)) {
        items.push(["enquiry-follow-up", "Change follow-up date"], ["enquiry-not-interested", "Mark not interested"], ["enquiry-edit", "Edit"]);
    } else if (enquiry.stage === "not_interested") {
        items.push(["enquiry-reopen", "Reopen"], ["enquiry-edit", "Edit"]);
    }
    items.push(["enquiry-delete", "Delete", true]);
    const buttons = items.map(([action, label, danger]) => `<button class="row-menu-item${danger ? " is-danger" : ""}" type="button" role="menuitem" data-action="${action}" data-id="${id}">${label}</button>`).join("");
    return `<div class="row-menu-wrap"><button class="row-menu-button" type="button" data-action="row-menu" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${escapeHTML(enquiry.full_name)}">⋯</button><div class="row-menu" role="menu" aria-label="Actions for ${escapeHTML(enquiry.full_name)}" hidden>${buttons}</div></div>`;
}

function card(enquiry) {
    const id = escapeHTML(enquiry.id);
    const interest = enquiry.interest_plan_name || enquiry.interest_text || "Not sure";
    let actions;
    if (isOpen(enquiry)) {
        const whatsapp = enquiryWhatsApp(enquiry);
        const message = whatsapp.link
            ? `<a class="button button-secondary button-small" href="${escapeHTML(whatsapp.link)}" target="_blank" rel="noopener noreferrer" data-enquiry-whatsapp="${id}">WhatsApp</a>`
            : `<span class="helper-text reminder-blocked">${escapeHTML(whatsapp.blocked)}</span><button class="button button-secondary button-small" type="button" data-action="enquiry-ask-consent" data-id="${id}">Ask for consent</button>`;
        actions = `${message}<button class="button button-primary button-small" type="button" data-action="enquiry-join" data-id="${id}">Join now</button>`;
    } else if (enquiry.stage === "joined" && enquiry.joined_member_id) {
        actions = `<button class="button button-secondary button-small" type="button" data-action="profile" data-id="${escapeHTML(enquiry.joined_member_id)}">Open member</button>`;
    } else {
        actions = "";
    }
    const contacted = enquiry.last_contacted_at ? ` · contacted ${formatDate(String(enquiry.last_contacted_at).slice(0, 10))}` : "";
    const overdue = followUpState(enquiry, today()) === "overdue";
    return `<article class="card enquiry-card${overdue ? " is-overdue" : ""}" data-enquiry-row="${id}">
        <div class="enquiry-person"><strong>${escapeHTML(enquiry.full_name)}</strong><small>${escapeHTML(formatPhone(last10(enquiry.phone)))}</small></div>
        <div class="enquiry-detail"><small>Interested in</small><strong>${escapeHTML(interest)}</strong><small>${escapeHTML(sourceLabel(enquiry.source))} · ${escapeHTML(ENQUIRY_STAGES[enquiry.stage] || enquiry.stage)}${escapeHTML(contacted)}</small>${enquiry.note ? `<small class="enquiry-note">${escapeHTML(enquiry.note)}</small>` : ""}</div>
        <div class="enquiry-follow">${followUpBadge(enquiry)}</div>
        <div class="enquiry-actions">${actions}${menu(enquiry)}</div>
    </article>`;
}

function statsPanel() {
    const stats = monthStats(enquiries.list, today());
    const month = new Intl.DateTimeFormat("en-IN", { month: "long", timeZone: "UTC" }).format(new Date(`${stats.month}-01T00:00:00Z`));
    const formula = stats.enquiries
        ? `Of the ${stats.enquiries} ${stats.enquiries === 1 ? "person" : "people"} who enquired in ${month}, ${stats.joined} joined: ${stats.joined} ÷ ${stats.enquiries} = ${stats.conversion}%.`
        : `No enquiries yet in ${month}.`;
    const sources = stats.bySource.filter((row) => row.enquiries).map((row) => `<li><span>${escapeHTML(row.label)}</span><strong>${row.enquiries}</strong><small>${row.joined} joined${row.conversion === null ? "" : ` · ${row.conversion}%`}</small></li>`).join("");
    return `<section class="card enquiry-stats" aria-label="This month's enquiries">
        <div class="summary-row"><span class="summary-chip"><strong>${stats.enquiries}</strong> enquiries this month</span><span class="summary-chip"><strong>${stats.joined}</strong> joined</span><span class="summary-chip"><strong>${stats.conversion === null ? "—" : `${stats.conversion}%`}</strong> conversion</span></div>
        <p class="helper-text">${escapeHTML(formula)}</p>
        ${sources ? `<ul class="enquiry-sources" aria-label="By source">${sources}</ul>` : ""}
    </section>`;
}

function tabEmpty(tab) {
    const add = `<button class="button button-primary" type="button" data-action="enquiry-add">Add enquiry</button>`;
    if (tab === "today") return emptyState(enquiries.list.some(isOpen) ? "No follow-ups due today. Nice! Open enquiries with later dates are on All open." : "No follow-ups due. Add an enquiry when someone visits.", enquiries.list.some(isOpen) ? "" : add);
    if (tab === "open") return emptyState("No open enquiries. Add one when someone visits and asks about joining.", add);
    if (tab === "joined") return emptyState("No one has joined from an enquiry yet. Use Join now on an enquiry when they sign up.");
    return emptyState("No one is marked not interested.");
}

export function renderEnquiriesPage() {
    const heading = `<div class="page-heading"><div><h1>Enquiries</h1><p>People who visited and might join. Anyone who doesn't join is deleted ${ENQUIRY_KEEP_DAYS} days after their enquiry last changed.</p></div><div class="heading-actions"><button class="button button-primary" type="button" data-action="enquiry-add">Add enquiry</button></div></div>`;
    if (enquiries.status === "idle" || enquiries.status === "loading") return `${heading}${renderSkeletonList({ count: 3, label: "Loading enquiries…", variant: "card" })}`;
    if (enquiries.status === "error") return `${heading}<div class="empty-state" role="alert"><p>${escapeHTML(enquiries.message)}</p><button class="button button-secondary" type="button" data-action="enquiry-retry">Try again</button></div>`;
    const counts = tabCounts(enquiries.list, today());
    const tabs = ENQUIRY_TABS.map((tab) => `<button class="tab-button${tab === currentTab ? " is-active" : ""}" type="button" role="tab" aria-selected="${tab === currentTab}" data-enquiry-tab="${tab}">${TAB_LABELS[tab]} <span class="count-pill">${counts[tab]}</span></button>`).join("");
    const rows = enquiriesOnTab(enquiries.list, currentTab, today());
    return `${heading}${statsPanel()}
        <div class="tab-row" role="tablist" aria-label="Enquiries">${tabs}</div>
        <div role="tabpanel">${rows.length ? `<div class="enquiry-list">${rows.map(card).join("")}</div>` : tabEmpty(currentTab)}</div>`;
}

// ---------- Add / edit ----------

let plansCache = null;
async function plans() {
    if (!plansCache) plansCache = await fetchActivePlans().catch(() => []);
    return plansCache;
}

function followUpField(selected) {
    const choices = followUpChoices(indiaISODate());
    const quick = choices.map(([key, label, date]) => `<button class="tab-button follow-choice${selected === date ? " is-active" : ""}" type="button" data-follow-date="${date}" aria-pressed="${selected === date}">${label}</button>`).join("");
    const picked = selected && !choices.some(([, , date]) => date === selected);
    return `<fieldset class="field full follow-up-field"><legend>Follow up</legend>
        <div class="follow-choices">${quick}<button class="tab-button follow-choice${picked ? " is-active" : ""}" type="button" data-follow-pick aria-pressed="${picked}">Pick date</button><button class="tab-button follow-choice${!selected ? " is-active" : ""}" type="button" data-follow-date="" aria-pressed="${!selected}">No follow-up</button></div>
        <input type="date" name="follow_up_on" id="enquiry-follow-date" min="${indiaISODate()}" value="${escapeHTML(selected || "")}" aria-label="Follow-up date" ${picked ? "" : "hidden"}>
    </fieldset>`;
}

function bindFollowUp(root) {
    const input = root.querySelector("#enquiry-follow-date");
    const mark = (button) => root.querySelectorAll(".follow-choice").forEach((item) => { item.classList.toggle("is-active", item === button); item.setAttribute("aria-pressed", String(item === button)); });
    root.querySelectorAll("[data-follow-date]").forEach((button) => button.addEventListener("click", () => { input.value = button.dataset.followDate; input.hidden = true; mark(button); }));
    root.querySelector("[data-follow-pick]")?.addEventListener("click", (event) => { input.hidden = false; mark(event.currentTarget); input.focus(); });
}

/** The Add enquiry (or Edit) sheet. Saving a new one then hands the phone to the visitor for consent. */
export async function openEnquiryForm(id = "", onChange = () => {}) {
    const existing = id ? find(id) : null;
    const planList = await plans();
    const tomorrow = followUpChoices(indiaISODate())[0][2];
    const value = (key, fallback = "") => escapeHTML(existing?.[key] ?? fallback);
    const options = `<option value="">Not sure</option>${planList.map((plan) => `<option value="${escapeHTML(plan.id)}" ${existing?.interest_plan_id === plan.id ? "selected" : ""}>${escapeHTML(plan.name)}</option>`).join("")}`;
    const sources = ENQUIRY_SOURCES.map(([source, label]) => `<label class="renew-method"><input type="radio" name="source" value="${source}" ${(existing?.source || "walk_in") === source ? "checked" : ""}><span>${label}</span></label>`).join("");
    openModal({
        title: existing ? "Edit enquiry" : "Add enquiry",
        subtitle: existing ? "" : "Someone visited and asked about joining.",
        body: `<form id="enquiry-form" autocomplete="off" class="form-grid enquiry-form" data-id="${escapeHTML(existing?.id || "")}" novalidate>
            <div class="field"><label for="enquiry-name">Name *</label><input id="enquiry-name" name="full_name" required maxlength="120" autocomplete="off" autocapitalize="words" value="${value("full_name")}"></div>
            <div class="field"><label for="enquiry-phone">Phone *</label><input id="enquiry-phone" name="phone" type="tel" autocomplete="off" inputmode="tel" required maxlength="16" placeholder="98765 43210" value="${existing ? escapeHTML(last10(existing.phone)) : ""}"></div>
            <div class="field"><label for="enquiry-interest">Interested in</label><select id="enquiry-interest" name="interest_plan_id">${options}</select></div>
            <fieldset class="field full"><legend>How they heard about us</legend><div class="renew-methods enquiry-sources-pick">${sources}</div></fieldset>
            <div class="field full"><label for="enquiry-note">Note (optional)</label><textarea id="enquiry-note" name="note" rows="2" maxlength="500">${value("note")}</textarea></div>
            ${followUpField(existing ? existing.follow_up_on || "" : tomorrow)}
            <p class="helper-text field-error full" id="enquiry-error" role="alert" hidden></p>
        </form>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit" form="enquiry-form">${existing ? "Save changes" : "Save enquiry"}</button>`
    });
    const form = document.querySelector("#enquiry-form");
    bindFollowUp(form);
    form.addEventListener("submit", (event) => { event.preventDefault(); saveEnquiry(form, onChange); });
    form.elements.full_name.focus();
}

function formError(form, message) {
    const box = form.querySelector("#enquiry-error");
    box.textContent = message;
    box.hidden = !message;
}

/** What the form sends; the phone is cleaned to +91 and 10 digits. Returns { body } or { problem }. */
export function enquiryFormBody(values) {
    const name = String(values.full_name || "").trim();
    if (!name) return { problem: "Enter the visitor's name." };
    const phone = cleanEnquiryPhone(values.phone);
    if (!phone) return { problem: "Enter a 10-digit Indian mobile number." };
    const followUp = String(values.follow_up_on || "");
    return {
        body: {
            full_name: name,
            phone,
            interest_plan_id: values.interest_plan_id || null,
            interest_text: values.interest_plan_id ? null : "Not sure",
            source: values.source || "walk_in",
            note: String(values.note || "").trim() || null,
            follow_up_on: followUp || null
        }
    };
}

async function saveEnquiry(form, onChange) {
    if (form.dataset.saving === "true") return;
    const { body, problem } = enquiryFormBody(Object.fromEntries(new FormData(form)));
    if (problem) return formError(form, problem);
    formError(form, "");
    form.dataset.saving = "true";
    const submit = document.querySelector('[type="submit"][form="enquiry-form"]');
    if (submit) submit.disabled = true;
    const id = form.dataset.id;
    try {
        const response = id ? await apiClient.put(`/api/enquiries/${id}`, body) : await apiClient.post("/api/enquiries", body);
        store(response?.data);
        onChange();
        if (id) {
            closeModal();
            toast(`Enquiry updated: ${response.data.full_name}.`);
        } else {
            toast(`Enquiry saved: ${response.data.full_name}.`);
            openConsentStep(response.data.id, onChange);
        }
    } catch (error) {
        const memberId = error?.details?.member_id;
        const enquiryId = error?.details?.enquiry_id;
        if (error?.code === "member_exists" && memberId) {
            // Already a member: say so and open them (main.js listens for this).
            closeModal();
            toast(error.message, "error");
            globalThis.dispatchEvent(new CustomEvent("gympulse:open-member", { detail: { id: memberId } }));
        } else if (error?.code === "enquiry_exists" && enquiryId) {
            // Already an open enquiry: open it.
            toast(error.message, "error");
            await loadEnquiries(onChange);
            if (find(enquiryId)) openEnquiryForm(enquiryId, onChange);
            else closeModal();
        } else {
            formError(form, error?.message || "The enquiry could not be saved.");
        }
    } finally {
        form.dataset.saving = "false";
        if (submit?.isConnected) submit.disabled = false;
    }
}

// ---------- The visitor's own WhatsApp consent (the staff phone is handed over) ----------

export function openConsentStep(id, onChange = () => {}) {
    const enquiry = find(id);
    if (!enquiry) return;
    const gym = state.gym.name || "This gym";
    openModal({
        title: "Hand the phone to the visitor",
        subtitle: `${enquiry.full_name}, please read and choose.`,
        body: `<div class="consent-step"><p class="consent-question">${escapeHTML(gym)} may message you on WhatsApp about your visit and offers.</p><p class="helper-text">You can ask the gym to stop at any time.</p></div>`,
        footer: `<button class="button button-secondary consent-answer" type="button" data-consent-answer="no">No thanks</button><button class="button button-primary consent-answer" type="button" data-consent-answer="yes">I agree</button>`
    });
    document.querySelectorAll("[data-consent-answer]").forEach((button) => button.addEventListener("click", async () => {
        const agree = button.dataset.consentAnswer === "yes";
        document.querySelectorAll("[data-consent-answer]").forEach((item) => { item.disabled = true; });
        try {
            const response = await apiClient.post(`/api/enquiries/${id}/consent`, { agree });
            store(response?.data);
            closeModal();
            toast(agree ? "Thank you! WhatsApp consent saved." : "Saved without WhatsApp consent.");
            onChange();
        } catch (error) {
            document.querySelectorAll("[data-consent-answer]").forEach((item) => { item.disabled = false; });
            toast(error.message || "The answer could not be saved. Please try again.", "error");
        }
    }));
}

// ---------- Follow-up date, WhatsApp, stage, delete ----------

function openFollowUpPicker(id, { title, subtitle = "", contacted = false }, onChange) {
    const enquiry = find(id);
    if (!enquiry) return;
    openModal({
        title,
        subtitle,
        body: `<form id="enquiry-follow-form" class="form-grid" novalidate>${followUpField(contacted ? followUpChoices(indiaISODate())[1][2] : enquiry.follow_up_on || "")}</form>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">${contacted ? "Skip" : "Cancel"}</button><button class="button button-primary" type="submit" form="enquiry-follow-form">Save follow-up</button>`
    });
    const form = document.querySelector("#enquiry-follow-form");
    bindFollowUp(form);
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            const response = await apiClient.put(`/api/enquiries/${id}`, { follow_up_on: form.elements.follow_up_on.value || null });
            store(response?.data);
            closeModal();
            toast(response.data.follow_up_on ? `Follow-up: ${formatDate(response.data.follow_up_on)}.` : "No follow-up date.");
            onChange();
        } catch (error) {
            toast(error.message || "The follow-up date could not be saved.", "error");
        }
    });
}

/** WhatsApp opened for an enquiry: Contacted now, then pick the next follow-up. The link itself opens WhatsApp. */
export async function recordEnquiryMessage(id, onChange = () => {}) {
    try {
        const response = await apiClient.post(`/api/enquiries/${id}/contacted`, {});
        store(response?.data);
        onChange();
        openFollowUpPicker(id, { title: "When to follow up next?", subtitle: `${response.data.full_name} is marked Contacted.`, contacted: true }, onChange);
    } catch (error) {
        toast(`WhatsApp opened, but the enquiry was not marked Contacted: ${error.message || "please try again"}`, "error");
    }
}

async function changeStage(id, stage, message, onChange) {
    try {
        const response = await apiClient.put(`/api/enquiries/${id}`, { stage });
        store(response?.data);
        toast(message.replace("{name}", response.data.full_name));
        onChange();
    } catch (error) {
        toast(error.message || "The enquiry could not be changed.", "error");
    }
}

function askDelete(id, onChange) {
    const enquiry = find(id);
    if (!enquiry) return;
    openModal({
        title: "Delete this enquiry?",
        body: `<p class="confirm-copy"><strong>${escapeHTML(enquiry.full_name)}</strong>'s enquiry is removed completely: name, phone and notes.</p>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-danger" type="button" id="enquiry-delete-confirm">Delete enquiry</button>`
    });
    document.querySelector("#enquiry-delete-confirm").addEventListener("click", async (event) => {
        event.currentTarget.disabled = true;
        try {
            await apiClient.delete(`/api/enquiries/${id}`);
            enquiries.list = enquiries.list.filter((item) => item.id !== id);
            closeModal();
            toast(`Enquiry deleted: ${enquiry.full_name}.`);
            onChange();
        } catch (error) {
            event.currentTarget.disabled = false;
            toast(error.message || "The enquiry could not be deleted.", "error");
        }
    });
}

// ---------- Join now ----------

/**
 * Join now: the Add member form, with the name, phone and (when given) the visitor's WhatsApp consent
 * filled in. The enquiry becomes Joined only once the member is saved (linkEnquiryToMember); Cancel
 * changes nothing. A phone that is already a member's just links them.
 */
function joinNow(id, openMemberForm, onChange) {
    const enquiry = find(id);
    if (!enquiry) return;
    const existing = state.members.find((member) => last10(member.phone) === last10(enquiry.phone));
    if (existing) {
        openModal({
            title: "Already a member",
            body: `<p class="confirm-copy"><strong>${escapeHTML(existing.name)}</strong> already has this phone number. Mark ${escapeHTML(enquiry.full_name)}'s enquiry as joined as this member?</p>`,
            footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="button" id="enquiry-link-existing">Mark joined</button>`
        });
        document.querySelector("#enquiry-link-existing").addEventListener("click", async () => {
            closeModal();
            await linkEnquiryToMember(id, existing.id, onChange);
        });
        return;
    }
    openMemberForm("", {
        enquiryId: enquiry.id,
        name: enquiry.full_name,
        phone: last10(enquiry.phone),
        whatsappOptIn: enquiry.whatsapp_consent === true,
        consentAt: enquiry.whatsapp_consent_at || "",
        planId: enquiry.interest_plan_id || ""
    });
}

/** After the member is saved: the enquiry is Joined and points at them. Never fails the member save. */
export async function linkEnquiryToMember(enquiryId, memberId, onChange = () => {}) {
    try {
        const response = await apiClient.post(`/api/enquiries/${enquiryId}/join`, { member_id: memberId });
        store(response?.data);
        onChange();
        return true;
    } catch (error) {
        toast(`Member saved, but the enquiry was not marked Joined: ${error.message || "please try again"}. Use Join now again to link them.`, "error");
        return false;
    }
}

/** The page's buttons. Returns true when the action was one of them. */
export function handleEnquiryAction(action, target, { openMemberForm, onChange }) {
    const id = target.dataset.id || "";
    switch (action) {
        case "enquiry-add": openEnquiryForm("", onChange); return true;
        case "enquiry-edit": openEnquiryForm(id, onChange); return true;
        case "enquiry-retry": loadEnquiries(onChange); return true;
        case "enquiry-ask-consent": openConsentStep(id, onChange); return true;
        case "enquiry-follow-up": openFollowUpPicker(id, { title: "Change follow-up date", subtitle: find(id)?.full_name || "" }, onChange); return true;
        case "enquiry-not-interested": changeStage(id, "not_interested", "Marked not interested: {name}.", onChange); return true;
        case "enquiry-reopen": changeStage(id, "new", "Enquiry reopened: {name}.", onChange); return true;
        case "enquiry-delete": askDelete(id, onChange); return true;
        case "enquiry-join": joinNow(id, openMemberForm, onChange); return true;
        default: return false;
    }
}
