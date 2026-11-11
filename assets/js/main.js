import {
    state,
    persist,
    resetDemo,
    getPlan,
    getMember,
    memberBalance,
    addPaidAmount,
    memberListPagination,
    initializationWarning,
    loadMembersFromApi,
    createMemberOnApi,
    updateMemberOnApi,
    updateMemberFieldsOnApi,
    setWhatsAppConsentOnApi,
    loadConsentHistory,
    deleteMemberOnApi
} from "./state.js";
import { renderDashboard, drawDashboardCharts } from "./modules/dashboard.js";
import { renderMembers, renderProfile } from "./modules/members.js";
import { renderPlansPage, loadPlans, setPlanSearch, setPlanStatus, handlePlanAction, handlePlanSubmit, updatePlanDurationField } from "./modules/plans.js";
import {
    handleMembershipAction,
    loadAllMemberships,
    loadMemberMembershipHistory,
    getCurrentMembership,
    setMemberCurrentMembership,
    submitMembershipAssignment,
    updateAssignmentForm
} from "./modules/memberMemberships.js";
import { fetchActivePlans } from "./api/plansApi.js";
import { fetchMembers } from "./api/membersApi.js";
import { fetchAllMemberPhones, importMembers, validateImportRows } from "./modules/memberImport.js";
import { createMemberPlanAssignment, fetchMemberMembershipHistory } from "./api/membershipsApi.js";
import { createPayment, fetchMemberPayments } from "./api/paymentsApi.js";
import { apiClient, clearAuthSession, restoreAuthSession, setAuthSession, setUnauthorizedHandler } from "./api/apiClient.js";
import { markReminderSent, renderExpiring } from "./modules/expiring.js";
import { renderOperationsPage, drawAnalyticsCharts } from "./modules/operations.js";
import { openModal, closeModal } from "./components/modal.js";
import { toast } from "./components/toast.js";
import { renderWhatsAppPage, handleWhatsAppAction, handleWhatsAppSubmit, handleWhatsAppChange } from "./modules/whatsapp.js";
import { applyNavigationTranslations, setLanguage, t } from "./i18n.js";
import { loadWelcomeFacts, loadWelcomeLog, loadWelcomeTemplates, welcomeBlocker } from "./modules/welcome.js";
import { handleWelcomeAction, handleWelcomeTemplateEvent, handleWelcomeTemplateSubmit, openMemberAddedDialog } from "./modules/welcomeUi.js";
import { escapeHTML, uid, localISODate, addDays, formatINR, formatDate, formatPhone, formatPlanDuration, memberStatus, parseCSV, downloadCSV, daysBetween, isValidIndianPhone, normalizeIndianPhone, cleanMemberName, memberNameIssue, MEMBER_NAME_MESSAGES, setDateFormat, setCurrency } from "./utils.js";
import { loadState, setStorageUser } from "./storage.js";
import { createDemoState } from "../../data/demo-data.js";

const page = document.querySelector("#page-content");
const viewTitles = {
    expiring: "Expiring soon", overview: "Overview", members: "Members", plans: "Membership plans", attendance: "Attendance", payments: "Payments",
    renewals: "Renewals", retention: "Retention", analytics: "Analytics", reports: "Reports",
    notifications: "Notifications", whatsapp: "WhatsApp inbox", integrations: "Integrations", settings: "Settings", profile: "Member profile"
};
let currentView = "expiring";
let profileId = "";
let memberFilters = { search: "", filter: "all", sort: "name", page: 1 };
let memberSearchTimer;
let memberRequestVersion = 0;
let importedRows = [];
let importPlans = [];
let currentFileName = "members.csv";
let memberPlanRequest = 0;
let memberSaving = false;
let expiringDays = 7;
let expiringMemberships = [];
let expiringStatus = "loading";
// "loading" until the first members request after sign-in finishes, so the list shows skeletons, not "No members yet".
let membersStatus = "loading";
// Total members in the gym, ignoring search and filters; shown on the Members nav badge.
let gymMemberTotal = null;
let memberTotalRequest = 0;
let expiringRequestVersion = 0;
let activeSession;

function showAuthScreen(onboarding = false, message = "") {
    document.querySelector("#auth-screen").hidden = false;
    document.querySelector("#app-shell").hidden = true;
    document.querySelector(".mobile-bottom-nav").hidden = true;
    document.querySelector("#login-form").hidden = onboarding;
    document.querySelector("#create-gym-form").hidden = !onboarding;
    document.querySelector("#auth-title").textContent = onboarding ? "Create your gym" : "Sign in to GymPulse";
    document.querySelector("#auth-description").textContent = onboarding
        ? "Your account is ready. Set up a gym workspace to continue."
        : "Use your owner account to manage your gym.";
    const error = document.querySelector(onboarding ? "#gym-error" : "#auth-error");
    error.textContent = message;
    error.hidden = !message;
}

function saveAuthNotice(message) {
    try {
        sessionStorage.setItem("gympulse.auth.notice", message);
    } catch (error) {
        console.error("GymPulse could not save the sign-in notice.", error);
    }
}

function takeAuthNotice() {
    try {
        const message = sessionStorage.getItem("gympulse.auth.notice") || "";
        sessionStorage.removeItem("gympulse.auth.notice");
        return message;
    } catch (error) {
        console.error("GymPulse could not read the sign-in notice.", error);
        return "";
    }
}

function loadUserWorkspace(userId) {
    setStorageUser(userId);
    const savedState = loadState();
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, savedState);
    if (!state.whatsapp) state.whatsapp = {};
    if (!state.apiMemberPayments) state.apiMemberPayments = {};
}

function startAuthenticatedApp(session) {
    activeSession = session;
    document.querySelector("#auth-screen").hidden = true;
    document.querySelector("#app-shell").hidden = false;
    document.querySelector(".mobile-bottom-nav").hidden = false;
    document.querySelector("#gym-name-label").textContent = session.gym.name;
    document.querySelector(".gym-avatar").textContent = session.gym.name.trim().slice(0, 1).toUpperCase() || "G";
    const ownerName = session.user.email || "Gym owner";
    document.querySelector(".sidebar-profile strong").textContent = ownerName;
    document.querySelector(".top-avatar").textContent = ownerName.slice(0, 1).toUpperCase();
    document.querySelector(".profile-avatar").textContent = ownerName.slice(0, 1).toUpperCase();
    state.gym.name = session.gym.name;
    state.gym.isDemo = session.gym.is_demo === true;
    render();
    refreshMembersFromApi();
    loadExpiringMemberships();
    // Loaded early so the "Member added" dialog can open WhatsApp without waiting.
    loadWelcomeTemplates();
    loadAllMemberships(() => {
        if (currentView === "overview") render();
    });
}

function acceptSession(session) {
    loadUserWorkspace(session.user.id);
    setAuthSession(session);
    activeSession = session;
    if (!session.gym) {
        showAuthScreen(true);
        return;
    }
    startAuthenticatedApp(session);
}

function expiryReminderTemplate() {
    return state.whatsapp.expiryReminderTemplate || "Hi {name}, your {plan} membership expires on {expiry_date}. We would love to see you again!";
}

function mapPayment(payment) {
    return {
        id: payment.id,
        memberId: payment.member_id,
        membershipId: payment.membership_id,
        amount: Number(payment.amount),
        date: payment.paid_on,
        method: payment.method.charAt(0).toUpperCase() + payment.method.slice(1),
        status: "paid",
        notes: payment.note || ""
    };
}

function render() {
    setDateFormat(state.gym.dateFormat || "DD MMM YYYY");
    setCurrency(state.gym.currency || "INR");
    applyNavigationTranslations();
    document.querySelectorAll(".nav-link[data-view]").forEach((link) => link.classList.toggle("active", link.dataset.view === currentView));
    // Keep the active page visible: open "More" whenever the current page lives inside it.
    if (document.querySelector(`#nav-more [data-view="${currentView}"]`)) setNavMoreOpen(true);
    const mobilePrimaryViews = ["expiring", "members", "plans", "attendance"];
    document.querySelectorAll(".mobile-nav-link[data-view]").forEach((link) => {
        const active = link.dataset.view === currentView;
        link.classList.toggle("active", active);
        link.setAttribute("aria-current", active ? "page" : "false");
    });
    document.querySelector('[data-action="mobile-more"]')?.classList.toggle("active", !mobilePrimaryViews.includes(currentView));
    const translatedViews = ["expiring", "overview", "members", "plans", "attendance", "payments", "renewals", "retention", "analytics", "reports", "notifications", "whatsapp", "integrations", "settings"];
    document.querySelector("#current-page").textContent = translatedViews.includes(currentView) ? t(currentView) : viewTitles[currentView] || "Overview";
    document.querySelector("#member-count").textContent = gymMemberTotal ?? "";
    document.querySelector("#gym-name-label").textContent = state.gym.name;
    document.querySelector(".gym-avatar").textContent = state.gym.name.trim().slice(0, 1).toUpperCase() || "G";
    const now = new Date();
    document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(now);
    if (currentView === "expiring") {
        page.innerHTML = renderExpiring(expiringMemberships, expiringStatus, expiringDays, expiryReminderTemplate(), new Set(Object.keys(state.expiryReminders || {})));
    } else if (currentView === "overview") {
        page.innerHTML = renderDashboard();
        drawDashboardCharts();
    } else if (currentView === "members") {
        page.innerHTML = renderMembers({ ...memberFilters, pagination: memberListPagination, loading: membersStatus === "loading" });
    } else if (currentView === "plans") {
        page.innerHTML = renderPlansPage();
    } else if (currentView === "whatsapp") {
        page.innerHTML = renderWhatsAppPage();
    } else if (currentView === "profile") {
        page.innerHTML = renderProfile(profileId);
    } else {
        page.innerHTML = renderOperationsPage(currentView);
        if (currentView === "analytics") drawAnalyticsCharts();
    }
    if (state.sampleDataLoaded) {
        page.insertAdjacentHTML("afterbegin", `<div class="note-box" role="status"><strong>DEMO SAMPLE DATA</strong> — fictional browser-only records; not stored in your gym database.</div>`);
    }
}

async function refreshMembersFromApi({ silent = false, page: requestedPage = memberFilters.page } = {}) {
    const requestVersion = ++memberRequestVersion;
    memberFilters.page = requestedPage;
    try {
        const members = await loadMembersFromApi({
            page: requestedPage,
            limit: 100,
            status: memberFilters.filter === "suspended" ? "suspended" : undefined,
            search: memberFilters.search
        });
        if (requestVersion !== memberRequestVersion) return;
        state.members = members;
        membersStatus = "ready";
        if (!memberFilters.search && memberFilters.filter !== "suspended") setGymMemberTotal(memberListPagination.total);
        else refreshMemberTotal();
        if (!silent) render();
    } catch (error) {
        if (requestVersion === memberRequestVersion) {
            if (membersStatus === "loading") {
                membersStatus = "ready";
                if (currentView === "members") render();
            }
            if (!silent) toast(error.message || "Unable to load members from the backend.", "error");
        }
    }
}

function setGymMemberTotal(total) {
    memberTotalRequest += 1;
    gymMemberTotal = Number(total) || 0;
    const badge = document.querySelector("#member-count");
    if (badge) badge.textContent = gymMemberTotal;
}

// Asks for one row of the unfiltered list just to read its total.
async function refreshMemberTotal() {
    const request = ++memberTotalRequest;
    try {
        const response = await fetchMembers({ page: 1, limit: 1 });
        if (request !== memberTotalRequest) return;
        const total = response?.total ?? response?.data?.pagination?.total;
        if (total !== undefined) setGymMemberTotal(total);
    } catch (error) {
        console.error("GymPulse could not load the member total.", error);
    }
}

function navigate(view) {
    if (!viewTitles[view]) return;
    currentView = view;
    if (view !== "profile") profileId = "";
    render();
    if (view === "expiring") loadExpiringMemberships();
    if (view === "plans") loadPlans(renderPlansIfCurrent);
    if (view === "settings") loadWelcomeTemplates({ force: true }).then(() => { if (currentView === "settings") render(); });
    if (view === "profile" && profileId) {
        loadMemberMembershipHistory(profileId);
        loadMemberPaymentsFromApi(profileId);
        loadProfileConsent(profileId);
        loadProfileWelcome(profileId);
    }
    if (initializationWarning) toast(initializationWarning, "error");
    page.focus({ preventScroll: true });
    closeMobileMenu();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadExpiringMemberships() {
    const requestVersion = ++expiringRequestVersion;
    expiringStatus = "loading";
    if (currentView === "expiring") render();
    try {
        const response = await apiClient.get("/api/memberships/expiring", { params: { days: expiringDays } });
        if (requestVersion !== expiringRequestVersion) return;
        expiringMemberships = Array.isArray(response.data) ? response.data : [];
        expiringStatus = "ready";
    } catch (error) {
        if (requestVersion !== expiringRequestVersion) return;
        expiringMemberships = [];
        expiringStatus = { message: error.message || "Unable to load expiring memberships." };
    }
    if (currentView === "expiring") render();
}

async function loadMemberPaymentsFromApi(memberId, { silent = false } = {}) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memberId)) return;
    try {
        const payments = await fetchMemberPayments(memberId);
        state.apiMemberPayments[memberId] = payments.map(mapPayment);
        if (currentView === "profile" && profileId === memberId) render();
    } catch (error) {
        if (silent) console.error(`GymPulse could not load payments for member ${memberId}.`, error);
        else toast(error.message || "Could not load member payment history.", "error");
    }
}

function loadProfileConsent(memberId) {
    loadConsentHistory(memberId, () => {
        if (currentView === "profile" && profileId === memberId) render();
    });
}

function loadProfileWelcome(memberId) {
    if (welcomeBlocker(getMember(memberId))) return;
    const rerenderProfile = () => {
        if (currentView === "profile" && profileId === memberId) render();
    };
    loadWelcomeLog(memberId, rerenderProfile);
    loadWelcomeFacts(memberId).then(rerenderProfile);
}

function rerenderAfterWelcome() {
    if (currentView === "profile" || currentView === "settings") render();
}

function renderPlansIfCurrent() {
    if (currentView === "plans") render();
}

function setNavMoreOpen(open) {
    const toggle = document.querySelector(".nav-more-toggle");
    const group = document.querySelector("#nav-more");
    if (!toggle || !group) return;
    toggle.setAttribute("aria-expanded", String(open));
    group.hidden = !open;
}

function closeMobileMenu() {
    document.querySelector("#sidebar").classList.remove("open");
    document.querySelector("#mobile-scrim").classList.remove("visible");
    document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
}

// Reminders are remembered in this browser only, keyed by membership and end date.
function recordExpiryReminder(key) {
    const cutoff = localISODate(new Date(Date.now() - 90 * 86400000));
    const kept = Object.entries(state.expiryReminders || {}).filter(([savedKey]) => savedKey.split(":").pop() >= cutoff);
    state.expiryReminders = { ...Object.fromEntries(kept), [key]: new Date().toISOString() };
    try {
        persist();
    } catch (error) {
        toast(error.message || "The reminder could not be saved in this browser.", "error");
    }
}

function safePersist(message = "Changes saved.") {
    try {
        persist();
        render();
        if (message) toast(message);
    } catch (error) {
        toast(error.message || "Unable to save changes.", "error");
    }
}

function setField(name, label, value = "", type = "text", required = false, extra = "") {
    return `<div class="field"><label for="form-${name}">${label}${required ? " *" : ""}</label><input id="form-${name}" name="${name}" type="${type}" value="${escapeHTML(value)}" ${required ? "required" : ""} ${extra}></div>`;
}

function memberPlanOptions(plans, selected = "") {
    return plans.map((plan) => `<option value="${escapeHTML(plan.id)}" data-name="${escapeHTML(plan.name)}" data-price="${Number(plan.price)}" data-days="${Number(plan.duration_days)}" ${plan.id === selected ? "selected" : ""}>${escapeHTML(plan.name)} — ${escapeHTML(formatPlanDuration(plan.duration_days))} — ${formatINR(plan.price)}</option>`).join("");
}

function demoRenewalPlanOptions(selected = "") {
    return state.plans
        .filter((plan) => plan.active)
        .map((plan) => `<option value="${escapeHTML(plan.id)}" data-price="${plan.price}" data-days="${plan.durationDays}" ${plan.id === selected ? "selected" : ""}>${escapeHTML(plan.name)} · ${formatINR(plan.price)}</option>`)
        .join("");
}

function renderMemberPlanField(status, plans = []) {
    if (status === "loading") {
        return `<div class="field full"><span class="field-label">Membership plan *</span>${fieldSkeleton("Loading membership plans…")}</div>`;
    }
    if (status === "error") {
        return `<div class="field full"><label>Membership plan *</label><p class="helper-text" role="alert">Unable to load membership plans. Please try again.</p><button class="button button-secondary" type="button" data-action="retry-member-plans">Try again</button></div>`;
    }
    if (status === "empty") {
        return `<div class="field full"><label>Membership plan *</label><p class="helper-text" role="status">No active membership plans available. Create a plan first.</p></div>`;
    }
    return `<div class="field full"><label for="form-planId">Membership plan *</label><select id="form-planId" name="planId" required><option value="">Select a plan</option>${memberPlanOptions(plans)}</select></div>`;
}

function renderMemberFormBody(member, planStatus = "loading", plans = []) {
    const isEdit = Boolean(member);
    const body = `<form id="member-form" data-mode="${isEdit ? "update" : "create"}" data-id="${escapeHTML(member?.id || "")}" data-plans-state="${isEdit ? "not-needed" : planStatus}" class="form-grid" novalidate>
            ${nameField("form", member?.name || "")}
            <div class="field"><label for="form-phone">Phone number *</label><input id="form-phone" name="phone" type="tel" value="${escapeHTML(member?.phone || "")}" inputmode="tel" maxlength="13" pattern="(?:\\+91)?[6-9][0-9]{9}" placeholder="9876543210 or +919876543210" required aria-describedby="form-phone-error"><span id="form-phone-error" class="helper-text phone-error" role="alert" hidden>Enter a valid Indian mobile number: 10 digits starting with 6–9, optionally with +91.</span></div>
            ${setField("email", "Email address", member?.email || "", "email")}
            ${setField("dob", "Date of birth", member?.dob || "", "date")}
            <div class="field"><label for="form-gender">Gender</label><select id="form-gender" name="gender"><option value="">Not specified</option>${["Female", "Male", "Prefer not to say"].map((item) => `<option ${member?.gender === item ? "selected" : ""}>${item}</option>`).join("")}</select></div>
            <div id="member-plan-field">${isEdit ? `<div class="field full"><label>Membership plan</label><p class="helper-text">Manage membership plans and dates using Assign plan.</p></div>` : renderMemberPlanField(planStatus, plans)}</div>
            <div class="field"><label for="form-status">Membership status</label><select id="form-status" name="status"><option value="active" ${member?.status !== "suspended" ? "selected" : ""}>Active</option><option value="suspended" ${member?.status === "suspended" ? "selected" : ""}>Suspended</option></select><span class="helper-text">Expired status is calculated from the expiry date.</span></div>
            ${isEdit
                ? `${setField("startDate", "Membership start date", member.startDate || "", "date", false, 'readonly aria-readonly="true"')}${setField("expiryDate", "Membership expiry date", member.expiryDate || "", "date", false, 'readonly aria-readonly="true"')}`
                : `${setField("assignmentStartDate", "Membership start date", localISODate(), "date", true)}<div class="field"><span class="field-label" id="form-expiry-label">Membership expiry</span><p class="readonly-value" id="form-expiry-text" aria-labelledby="form-expiry-label" aria-live="polite">${EXPIRY_PLACEHOLDER}</p><input type="hidden" name="assignmentEndDate" value=""><span class="helper-text">Calculated from the plan and start date.</span></div>`}
            ${isEdit
                ? `<div class="field"><span class="field-label">Total billed fees</span><p class="readonly-value">${formatINR(member.totalFees || 0)}</p><span class="helper-text">Fees are saved with each plan assignment and cannot be edited here.</span></div>`
                : setField("totalFees", "Membership fee (₹)", "", "number", true, 'min="0" step="1"')}
            ${!isEdit ? setField("initialPayment", "Amount collected now (₹)", 0, "number", false, 'min="0" step="1"') : ""}
            ${setField("emergencyContact", "Emergency contact", member?.emergencyContact || "", "tel")}
            <p class="helper-text field full" id="member-assignment-error" role="alert" hidden></p>
            <div class="field full"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="whatsappOptIn" ${member?.whatsappOptIn === true ? "checked" : ""}> Member agrees to receive WhatsApp updates</label><span class="helper-text">${member?.whatsappOptIn && member.whatsappOptInAt ? `Consent recorded on ${escapeHTML(formatDate(member.whatsappOptInAt.slice(0, 10)))}. ` : ""}Only tick this when the member has agreed. Every change is kept in their consent history, and reminders skip members without consent.</span></div>
            <div class="field full"><label for="form-notes">Notes</label><textarea id="form-notes" name="notes">${escapeHTML(member?.notes || "")}</textarea></div>
            <p class="helper-text field full">Phone numbers must be unique. For imports, use columns: name, phone, email, plan, joinedAt, startDate, expiryDate.</p>
        </form>`;
    return body;
}

async function loadMemberFormPlans(form) {
    const requestId = ++memberPlanRequest;
    form.dataset.planRequest = String(requestId);
    form.dataset.plansState = "loading";
    const container = form.querySelector("#member-plan-field");
    const submit = document.querySelector('[type="submit"][form="member-form"]');
    if (container) container.innerHTML = renderMemberPlanField("loading");
    if (submit) submit.disabled = true;

    try {
        const plans = await fetchActivePlans();
        if (!form.isConnected || form.dataset.planRequest !== String(requestId)) return;
        const status = plans.length ? "ready" : "empty";
        form.dataset.plansState = status;
        if (container) container.innerHTML = renderMemberPlanField(status, plans);
        form.elements.totalFees.value = "";
        if (submit) submit.disabled = status !== "ready";
        updateMemberAssignmentPreview(form);
    } catch {
        if (!form.isConnected || form.dataset.planRequest !== String(requestId)) return;
        form.dataset.plansState = "error";
        if (container) container.innerHTML = renderMemberPlanField("error");
        form.elements.totalFees.value = "";
        if (submit) submit.disabled = true;
    }
}

function openMemberForm(memberId = "") {
    const member = memberId ? getMember(memberId) : null;
    if (memberId && !member) return toast("Member was not found.", "error");
    const isEdit = Boolean(member);
    openModal({
        title: isEdit ? "Edit member" : "Add a member",
        subtitle: isEdit ? `Update ${member.name}'s profile and membership.` : "Add someone new to your gym community.",
        wide: true,
        body: renderMemberFormBody(member, isEdit ? "not-needed" : "loading"),
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit" form="member-form" ${isEdit ? "" : "disabled"}>${isEdit ? "Save changes" : "Add member"}</button>`
    });
    const form = document.querySelector("#member-form");
    if (!isEdit) loadMemberFormPlans(form);
}

const EXPIRY_PLACEHOLDER = "Choose a plan to see the expiry date";

// A grey input-sized placeholder shown while a select's options load.
function fieldSkeleton(label) {
    return `<div class="skeleton-field" role="status"><span class="sr-only">${escapeHTML(label)}</span><span class="skeleton-block" aria-hidden="true"></span></div>`;
}

function renderQuickAddPlanField(status, plans = []) {
    if (status === "loading") {
        return `<div class="field"><span class="field-label">${t("plan")} *</span>${fieldSkeleton("Loading plans…")}</div>`;
    }
    if (status === "error") {
        return `<div class="field"><label for="quick-planId">${t("plan")} *</label><p class="helper-text" role="alert">Plans could not be loaded.</p><button class="button button-secondary" type="button" data-action="retry-quick-add-plans">Try again</button></div>`;
    }
    if (!plans.length) {
        return `<div class="field"><label for="quick-planId">${t("plan")} *</label><p class="helper-text" role="status">No active plans available. Create a plan first.</p></div>`;
    }
    return `<div class="field"><label for="quick-planId">${t("plan")} *</label><select id="quick-planId" name="planId" required><option value="">Select a plan</option>${memberPlanOptions(plans)}</select></div>`;
}

async function loadQuickAddPlans(form) {
    const submit = document.querySelector('[type="submit"][form="quick-member-form"]');
    form.dataset.plansState = "loading";
    if (submit) submit.disabled = true;
    form.querySelector("#quick-plan-field").innerHTML = renderQuickAddPlanField("loading");
    try {
        const plans = await fetchActivePlans();
        if (!form.isConnected) return;
        form.dataset.plansState = plans.length ? "ready" : "empty";
        form.querySelector("#quick-plan-field").innerHTML = renderQuickAddPlanField(form.dataset.plansState, plans);
        if (submit) submit.disabled = !plans.length;
    } catch (error) {
        if (!form.isConnected) return;
        form.dataset.plansState = "error";
        form.querySelector("#quick-plan-field").innerHTML = renderQuickAddPlanField("error");
        if (submit) submit.disabled = true;
        console.error("Unable to load plans for quick add.", error);
    }
}

function openQuickAddMemberForm() {
    openModal({
        title: t("quickAdd"),
        subtitle: t("quickAddSubtitle"),
        body: `<form id="quick-member-form" class="quick-add-form" data-plans-state="loading" novalidate>
            ${nameField("quick", "", t("name"))}
            <div class="field"><label for="quick-phone">${t("phone")} *</label><input id="quick-phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" maxlength="13" pattern="(?:\\+91)?[6-9][0-9]{9}" placeholder="9876543210 or +919876543210" required aria-describedby="quick-phone-error"><span id="quick-phone-error" class="helper-text phone-error" role="alert" hidden>${t("phoneHelp")}</span></div>
            <div id="quick-plan-field">${renderQuickAddPlanField("loading")}</div>
            ${consentField()}
            <p class="helper-text" id="quick-assignment-error" role="alert" hidden></p>
        </form>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">${t("cancel")}</button><button class="button button-primary" type="submit" form="quick-member-form" disabled>${t("addAssign")}</button>`
    });
    loadQuickAddPlans(document.querySelector("#quick-member-form"));
}

function consentField() {
    return `<div class="field consent-field"><label class="checkbox-label"><input type="checkbox" name="whatsappOptIn"> Member agrees to receive WhatsApp updates</label><span class="helper-text">Only tick this when the member has agreed. It is kept in their consent history.</span></div>`;
}

// Records consent through the consent endpoint (migration 009), after the member exists.
async function recordFormConsent(memberId, optIn) {
    const member = getMember(memberId);
    if (!member || optIn === (member.whatsappOptIn === true)) return;
    try {
        await setWhatsAppConsentOnApi(memberId, optIn, "staff_form");
    } catch (error) {
        const failure = new Error(`Member saved, but WhatsApp consent was not recorded: ${String(error.message || "please try again").replace(/\.+$/, "")}. Press the button again to retry.`);
        failure.stage = "consent";
        throw failure;
    }
    if (currentView === "profile" && profileId === memberId) loadProfileConsent(memberId);
}

// After a successful save: the welcome dialog when the member consented, otherwise a toast.
async function finishMemberSave(memberId, message) {
    const member = getMember(memberId);
    if (member && !welcomeBlocker(member)) {
        safePersist(null);
        if (await openMemberAddedDialog(member)) return;
    }
    closeModal();
    safePersist(message);
}

function nameField(prefix, value, label = "Full name") {
    return `<div class="field"><label for="${prefix}-name">${escapeHTML(label)} *</label><input id="${prefix}-name" name="name" type="text" value="${escapeHTML(value)}" autocomplete="name" maxlength="200" placeholder="Member name" required aria-describedby="${prefix}-name-error"><span id="${prefix}-name-error" class="helper-text name-error" role="alert" hidden></span></div>`;
}

async function saveQuickMember(form) {
    const name = cleanMemberName(form.elements.name.value);
    const enteredPhone = String(form.elements.phone.value || "").trim();
    const phone = normalizeIndianPhone(enteredPhone);
    const nameIssue = memberNameIssue(name);
    if (nameIssue) throw new Error(MEMBER_NAME_MESSAGES[nameIssue]);
    if (!isValidIndianPhone(enteredPhone)) throw new Error("Enter a valid Indian mobile number: 10 digits starting with 6–9, optionally with +91.");
    if (form.dataset.plansState !== "ready") throw new Error("An active membership plan is required.");
    const planId = form.dataset.createdPlanId || form.elements.planId.value;
    if (!planId) throw new Error("Select an active membership plan.");
    const startDate = form.dataset.createdStartDate || localISODate();
    let member;
    if (form.dataset.createdMemberId) {
        member = getMember(form.dataset.createdMemberId);
        if (!member) throw new Error("The member was saved, but could not be reloaded. Refresh the member list before retrying.");
    } else {
        const duplicate = state.members.find((item) => normalizeIndianPhone(item.phone) === phone);
        if (duplicate) throw new Error(`This phone number already belongs to ${duplicate.name}.`);
        member = await createMemberOnApi({ name, phone });
        if (!member?.id) throw new Error("The member was not returned by the backend.");
        refreshMemberTotal();
        form.dataset.createdMemberId = member.id;
        form.dataset.createdPlanId = planId;
        form.dataset.createdStartDate = startDate;
        form.elements.name.readOnly = true;
        form.elements.phone.readOnly = true;
        form.elements.planId.disabled = true;
    }
    const priorAssignments = await fetchMemberMembershipHistory(member.id);
    const assignment = priorAssignments.find((item) => item.plan_id === planId && item.start_date === startDate)
        || await createMemberPlanAssignment(member.id, planId, startDate);
    if (!assignment) throw new Error("The assignment API did not return the saved membership.");
    setMemberCurrentMembership(member.id, assignment);
    const updatedMember = {
        ...member,
        planId: assignment.plan_id,
        currentMembership: assignment,
        membershipStatus: assignment.effective_status || "active",
        startDate: assignment.start_date,
        expiryDate: assignment.end_date
    };
    const index = state.members.findIndex((item) => item.id === member.id);
    if (index >= 0) state.members[index] = updatedMember;
    await recordFormConsent(member.id, form.elements.whatsappOptIn.checked);
    const error = form.querySelector("#quick-assignment-error");
    if (error) error.hidden = true;
    await finishMemberSave(member.id, "Member added and plan assigned.");
}

function openPaymentForm(memberId = "", membershipId = "", suggestedAmount = "") {
    let member = memberId ? getMember(memberId) : null;
    if (!member && memberId) {
        const expiring = expiringMemberships.find((item) => item.member.id === memberId);
        if (expiring) {
            member = {
                id: memberId,
                name: expiring.member.full_name,
                phone: expiring.member.phone,
                planId: expiring.plan_id,
                currentMembership: expiring,
                membershipStatus: expiring.effective_status,
                startDate: expiring.start_date,
                expiryDate: expiring.end_date,
                totalFees: Number(expiring.price),
                status: "active"
            };
            state.members.unshift(member);
        }
    }
    if (memberId && !member) return toast("Member was not found.", "error");
    const membership = member ? getCurrentMembership(member.id) || member.currentMembership : null;
    const choices = state.members.map((item) => `<option value="${escapeHTML(item.id)}" ${member?.id === item.id ? "selected" : ""}>${escapeHTML(item.name)} · ${escapeHTML(item.id)}</option>`).join("");
    openModal({
        title: t("recordPayment"),
        subtitle: t("paymentSubtitle"),
        body: `<form id="payment-form" class="form-grid" data-membership-id="${escapeHTML(membershipId || membership?.id || "")}">
            <div class="field full"><label for="form-memberId">${t("member")} *</label><select id="form-memberId" name="memberId" required><option value="">${t("selectMember")}</option>${choices}</select></div>
            ${setField("amount", t("amountCollected"), suggestedAmount || membership?.price || "", "number", true, 'min="1" step="0.01"')}
            <div class="field"><label for="form-method">${t("paymentMethod")}</label><select id="form-method" name="method">${[["upi", "UPI"], ["cash", "Cash"], ["card", "Card"], ["other", "Other"]].map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></div>
            ${setField("date", t("paidOn"), localISODate(), "date", true)}
            <div class="field full"><label for="form-notes">${t("note")}</label><textarea id="form-notes" name="notes" placeholder="Optional reference or payment note"></textarea></div>
        </form>`,
        footer: `<button class="button button-secondary" data-action="close-modal" type="button">${t("cancel")}</button><button class="button button-primary" type="submit" form="payment-form">${t("save")}</button>`
    });
}

function openCheckInForm(memberId = "", source = "manual") {
    const member = memberId ? getMember(memberId) : null;
    const choices = state.members.map((item) => `<option value="${escapeHTML(item.id)}" ${member?.id === item.id ? "selected" : ""}>${escapeHTML(item.name)} · ${escapeHTML(item.id)}</option>`).join("");
    openModal({
        title: source === "fingerprint" ? "Fingerprint scan simulation" : source === "qr" ? "QR check-in demo" : "Check in a member",
        subtitle: source === "fingerprint" ? "Simulation only — no biometric data or device connection is used." : "Select a member to record an attendance event.",
        body: `<form id="checkin-form" data-source="${escapeHTML(source)}"><div class="field"><label for="form-memberId">Member *</label><select id="form-memberId" name="memberId" required><option value="">Select a member</option>${choices}</select></div>
            <div class="note-box" style="margin-top:13px">${source === "fingerprint" ? "A successful simulated match records a normal attendance event. No fingerprint image or template is captured or stored." : "A second check-in for the same member on the same day will be prevented."}</div>
            <div id="checkin-warning" class="helper-text" style="margin-top:9px"></div></form>`,
        footer: `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button button-primary" type="submit" form="checkin-form">${source === "fingerprint" ? "Simulate successful scan" : "Record check-in"}</button>`
    });
}

function openRenewForm(memberId) {
    const member = getMember(memberId);
    if (!member) return toast("Member was not found.", "error");
    const selectedPlan = getPlan(member.planId) || state.plans.find((plan) => plan.active);
    const start = member.expiryDate >= localISODate() ? addDays(member.expiryDate, 1) : localISODate();
    openModal({
        title: `Renew ${escapeHTML(member.name)}'s membership`,
        subtitle: "Previous membership activity will remain in the renewal history.",
        body: `<form id="renew-form" data-id="${escapeHTML(member.id)}" class="form-grid">
            <div class="field full"><label for="form-planId">New plan *</label><select id="form-planId" name="planId" required>${demoRenewalPlanOptions(selectedPlan?.id)}</select></div>
            ${setField("startDate", "New start date", start, "date", true)}
            ${setField("expiryDate", "New expiry date", addDays(start, selectedPlan?.durationDays || 30), "date", true)}
            ${setField("amount", "Payment collected now (₹)", selectedPlan?.price || 0, "number", true, 'min="0" step="1"')}
            <div class="field"><label for="form-method">Payment method</label><select id="form-method" name="method">${["UPI", "Cash", "Card", "Bank transfer", "Other"].map((method) => `<option>${method}</option>`).join("")}</select></div>
            <div class="field full helper-text">New membership fee will be added to the member's billed fees. Any partial payment remains outstanding.</div>
        </form>`,
        footer: `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button button-primary" type="submit" form="renew-form">Save renewal</button>`
    });
}

function askDeleteMember(memberId) {
    const member = getMember(memberId);
    if (!member) return toast("Member was not found.", "error");
    openModal({
        title: "Archive member?",
        body: `<p class="confirm-copy">Archive <strong>${escapeHTML(member.name)}</strong>? They will be hidden from the member list, while their linked payment and attendance records remain preserved.</p>`,
        footer: `<button class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-danger" data-action="confirm-delete-member" data-id="${escapeHTML(member.id)}">Archive member</button>`
    });
}

function openReceipt(paymentId) {
    const payment = state.payments.find((item) => item.id === paymentId)
        || Object.values(state.apiMemberPayments).flat().find((item) => item.id === paymentId);
    if (!payment) return toast("Payment was not found.", "error");
    const member = getMember(payment.memberId);
    const shareText = `Payment receipt for ${member?.name || "member"}: ${formatINR(payment.amount)} on ${formatDate(payment.date)}. Receipt ${payment.id}.`;
    const sharePhone = normalizeIndianPhone(member?.phone || "").replace(/\D/g, "");
    const shareUrl = member && /^[6-9]\d{9}$/.test(sharePhone)
        ? `https://wa.me/91${sharePhone}?text=${encodeURIComponent(shareText)}`
        : "";
    openModal({
        title: "Payment receipt preview",
        subtitle: "A local preview only; this is not a tax invoice.",
        body: `<div class="card" style="padding:18px"><div style="font:800 17px Manrope,sans-serif;color:#173f32">${escapeHTML(state.gym.name)}</div><p class="helper-text">${escapeHTML(state.gym.address || "")}</p><hr style="border:0;border-top:1px solid #e8ede7"><div class="profile-fields">${receiptRow("Transaction ID", payment.id)}${receiptRow("Member", member?.name || "Removed member")}${receiptRow("Date", formatDate(payment.date))}${receiptRow("Method", payment.method)}${receiptRow("Status", payment.status)}${receiptRow("Amount", formatINR(payment.amount))}</div><p class="helper-text" style="margin-top:15px">Manually recorded payment · no gateway transaction</p></div>`,
        footer: `${shareUrl ? `<a class="button button-secondary" href="${escapeHTML(shareUrl)}" target="_blank" rel="noopener noreferrer">Share via WhatsApp</a>` : ""}<button class="button button-secondary" data-action="print-receipt" data-id="${escapeHTML(payment.id)}">Print receipt</button><button class="button button-primary" data-action="close-modal">Done</button>`
    });
}

function printReceipt(paymentId) {
    const payment = state.payments.find((item) => item.id === paymentId)
        || Object.values(state.apiMemberPayments).flat().find((item) => item.id === paymentId);
    if (!payment) return toast("Payment was not found.", "error");
    const member = getMember(payment.memberId);
    const popup = window.open("", "_blank");
    if (!popup) return toast("Allow pop-ups to print this receipt.", "error");
    popup.opener = null;
    const rows = [
        ["Receipt", payment.id],
        ["Member", member?.name || "Removed member"],
        ["Phone", formatPhone(member?.phone) || "—"],
        ["Date", formatDate(payment.date)],
        ["Method", payment.method],
        ["Amount", formatINR(payment.amount)]
    ];
    popup.document.write(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Payment receipt</title><style>body{font:16px Arial,sans-serif;max-width:640px;margin:40px auto;padding:24px;color:#173f32}h1{font-size:24px}table{width:100%;border-collapse:collapse}td{padding:10px;border-bottom:1px solid #ddd}td:first-child{color:#536057}strong{font-size:22px}</style><h1>${escapeHTML(state.gym.name)} · Payment receipt</h1><p>${escapeHTML(state.gym.address || "")}</p><table>${rows.map(([label, value]) => `<tr><td>${escapeHTML(label)}</td><td>${escapeHTML(value)}</td></tr>`).join("")}</table><p>This is a manually recorded payment receipt, not a tax invoice.</p></html>`);
    popup.document.close();
    popup.focus();
    popup.print();
}

function receiptRow(label, value) {
    return `<div><label>${escapeHTML(label)}</label><strong>${escapeHTML(value)}</strong></div>`;
}

function handleAction(action, target) {
    const id = target.dataset.id || "";
    switch (action) {
        case "close-modal": closeModal(); break;
        case "add-member": openMemberForm(); break;
        case "quick-add-member": openQuickAddMemberForm(); break;
        case "mobile-more": openMobileMenu(); break;
        case "edit-member": openMemberForm(id); break;
        case "profile": profileId = id; navigate("profile"); break;
        case "delete-member": askDeleteMember(id); break;
        case "confirm-delete-member": {
            (async () => {
                try {
                    await deleteMemberOnApi(id);
                    refreshMemberTotal();
                    state.payments = state.payments.filter((payment) => payment.memberId !== id);
                    state.attendance = state.attendance.filter((record) => record.memberId !== id);
                    closeModal();
                    safePersist("Member archived; linked records were preserved.");
                } catch (error) {
                    toast(error.message || "Member could not be deleted.", "error");
                }
            })();
            break;
        }
        case "record-payment": openPaymentForm(id, target.dataset.membershipId || "", target.dataset.amount || ""); break;
        case "check-in": openCheckInForm(id); break;
        case "qr-check-in": openCheckInForm("", "qr"); break;
        case "fingerprint": openCheckInForm("", "fingerprint"); break;
        case "check-out": checkOut(id); break;
        case "renew-member": openRenewForm(id); break;
        case "export-members": exportMembers(); break;
        case "export-payments": exportPayments(); break;
        case "export-renewals": exportRenewals(); break;
        case "export-retention": exportRetention(); break;
        case "export-analytics": exportAnalytics(); break;
        case "download-report": downloadReport(); break;
        case "import-csv": document.querySelector("#csv-file").click(); break;
        case "confirm-import": confirmImport(); break;
        case "copy-message": copyMessage(target.dataset.message || ""); break;
        case "receipt": openReceipt(id); break;
        case "print-receipt": printReceipt(id); break;
        case "reset-demo": resetDemoData(); break;
        case "load-sample-data": if (state.gym.isDemo) loadSampleData(); break;
        default: break;
    }
}

function checkOut(attendanceId) {
    const record = state.attendance.find((item) => item.id === attendanceId);
    if (!record || record.checkedOutAt) return toast("This attendance record is not available for check-out.", "error");
    record.checkedOutAt = new Date().toISOString();
    safePersist("Check-out recorded.");
}

function updateMemberFormDefaults(target) {
    const form = target.closest("form");
    if (!form) return;
    if (form.id === "member-form" && form.dataset.mode === "create" && target.name === "planId") {
        const option = target.selectedOptions[0];
        form.elements.totalFees.value = option?.value ? option.dataset.price : "";
        updateMemberAssignmentPreview(form);
    }
    if ((form.id === "renew-form" || form.id === "member-form") && target.name === "planId" && form.id === "renew-form") {
        const option = target.selectedOptions[0];
        const startDate = form.elements.startDate.value;
        form.elements.expiryDate.value = addDays(startDate, Number(option?.dataset.days || 30));
        form.elements.amount.value = option?.dataset.price || "0";
    }
    if (form.id === "renew-form" && target.name === "startDate") {
        const option = form.elements.planId.selectedOptions[0];
        form.elements.expiryDate.value = addDays(target.value, Number(option?.dataset.days || 30));
    }
    if (form.id === "member-form" && target.name === "assignmentStartDate") {
        updateMemberAssignmentPreview(form);
    }
    if (form.id === "checkin-form" && target.name === "memberId") {
        const member = getMember(target.value);
        document.querySelector("#checkin-warning").textContent = member && memberStatus(member) === "expired" ? "This membership has expired. Submitting will require confirmation." : "";
    }
}

function updateMemberAssignmentPreview(form) {
    const plan = form.elements.planId?.selectedOptions[0];
    const startDate = form.elements.assignmentStartDate?.value;
    const expiry = form.elements.assignmentEndDate;
    if (!expiry) return;
    const duration = Number(plan?.dataset.days || 0);
    expiry.value = plan?.value && startDate && duration > 0
        ? addDays(startDate, duration - 1)
        : "";
    const text = form.querySelector("#form-expiry-text");
    if (text) {
        text.textContent = expiry.value ? formatDate(expiry.value) : startDate ? EXPIRY_PLACEHOLDER : "Choose a start date to see the expiry date";
    }
}

function phoneDigits(phone) {
    if (isValidIndianPhone(phone)) return normalizeIndianPhone(phone);
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
    if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
    return digits;
}

function uniqueMemberId() {
    let id = uid("GP");
    while (state.members.some((member) => member.id === id)) id = uid("GP");
    return id;
}

function adjustCharges(charges, totalFees, date) {
    const updated = charges?.length
        ? charges.map((charge) => ({ ...charge, amount: Number(charge.amount) || 0 }))
        : [{ amount: Number(totalFees), date }];
    let difference = Number(totalFees) - updated.reduce((sum, charge) => sum + charge.amount, 0);
    if (difference > 0) updated[updated.length - 1].amount += difference;
    else {
        for (let index = updated.length - 1; index >= 0 && difference < 0; index -= 1) {
            const reduction = Math.min(updated[index].amount, Math.abs(difference));
            updated[index].amount -= reduction;
            difference += reduction;
        }
    }
    return updated.filter((charge) => charge.amount > 0);
}

async function saveMember(form) {
    const values = new FormData(form);
    const isNewMember = form.dataset.mode === "create";
    if (isNewMember && form.dataset.plansState !== "ready") {
        throw new Error(form.dataset.plansState === "empty"
            ? "No active membership plans available. Create a plan first."
            : "Unable to load membership plans. Please try again.");
    }
    const name = cleanMemberName(values.get("name"));
    const nameIssue = memberNameIssue(name);
    if (nameIssue) throw new Error(MEMBER_NAME_MESSAGES[nameIssue]);
    const enteredPhone = String(values.get("phone") || "").trim();
    if (!isValidIndianPhone(enteredPhone)) throw new Error("Enter a valid Indian mobile number: 10 digits starting with 6–9, optionally with +91.");
    const phone = normalizeIndianPhone(enteredPhone);
    const currentId = form.dataset.createdMemberId || form.dataset.id || "";
    const current = currentId ? getMember(currentId) : null;
    const duplicate = state.members.find((member) => member.phone === phone && member.id !== (current?.id || ""));
    if (duplicate) throw new Error(`This phone number already belongs to ${duplicate.name}.`);
    const selectedOption = isNewMember ? form.elements.planId?.selectedOptions[0] : null;
    const planId = isNewMember
        ? form.dataset.pendingPlanId || selectedOption?.value || ""
        : current?.planId || "";
    if (isNewMember && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(planId)) {
        throw new Error("Select an active membership plan.");
    }
    const plan = isNewMember
        ? { id: planId, name: selectedOption?.dataset.name || "", price: Number(selectedOption?.dataset.price) }
        : null;
    const totalFees = isNewMember ? Number(values.get("totalFees")) : Number(current?.totalFees || 0);
    if (!Number.isFinite(totalFees) || totalFees < 0) throw new Error("Membership fees must be zero or more.");
    const initialPayment = Number(values.get("initialPayment") || 0);
    if (!Number.isFinite(initialPayment) || initialPayment < 0 || initialPayment > totalFees) throw new Error("Initial payment must be between zero and the membership fee.");
    const startDate = isNewMember
        ? form.dataset.pendingStartDate || form.elements.assignmentStartDate.value
        : current?.startDate || "";
    if (isNewMember && !startDate) throw new Error("Choose a membership start date.");
    const expiryDate = isNewMember ? form.elements.assignmentEndDate.value : current?.expiryDate || "";

    const record = {
        id: current?.id || uniqueMemberId(),
        memberCode: current?.memberCode || "",
        name,
        phone,
        email: String(values.get("email") || "").trim(),
        dob: String(values.get("dob") || ""),
        gender: String(values.get("gender") || ""),
        planId: plan?.id || current?.planId || "",
        startDate,
        expiryDate,
        totalFees,
        status: String(values.get("status") || current?.status || "active"),
        emergencyContact: String(values.get("emergencyContact") || "").trim(),
        whatsappOptIn: values.has("whatsappOptIn"),
        notes: String(values.get("notes") || "").trim(),
        renewals: current?.renewals || [],
        followUpStatus: current?.followUpStatus || "pending",
        charges: current?.charges || [{ amount: totalFees, date: startDate }]
    };

    const saved = current
        ? await updateMemberOnApi(current.id, record)
        : await createMemberOnApi(record);
    if (!saved?.id) throw new Error("The member was not returned by the backend.");
    let createdAssignment = null;
    if (isNewMember && !current) refreshMemberTotal();
    if (isNewMember) {
        form.dataset.createdMemberId = saved.id;
        form.dataset.id = saved.id;
        form.dataset.pendingPlanId = plan.id;
        form.dataset.pendingStartDate = startDate;
        form.dataset.assignmentPending = "true";
        const planSelect = form.elements.planId;
        const startDateInput = form.elements.assignmentStartDate;
        if (planSelect) planSelect.disabled = true;
        if (startDateInput) startDateInput.disabled = true;
        const submitButton = document.querySelector('[type="submit"][form="member-form"]');
        if (submitButton) submitButton.textContent = "Retry plan assignment";

        let assignment;
        const previousAssignments = await fetchMemberMembershipHistory(saved.id);
        assignment = previousAssignments.find((item) => item.plan_id === plan.id && item.start_date === startDate);
        if (!assignment) assignment = await createMemberPlanAssignment(saved.id, plan.id, startDate, totalFees);
        if (!assignment) throw new Error("The assignment API did not return the saved membership.");
        createdAssignment = assignment;
        const assignmentError = form.querySelector("#member-assignment-error");
        if (assignmentError) {
            assignmentError.hidden = true;
            assignmentError.textContent = "";
        }
        form.dataset.assignmentPending = "false";
        form.dataset.assignedStartDate = assignment.start_date;
        form.dataset.assignedEndDate = assignment.end_date;
    }

    if (saved) {
        const normalized = {
            ...(current || record),
            ...saved,
            planId: createdAssignment?.plan_id || current?.planId || record.planId,
            currentMembership: createdAssignment || current?.currentMembership || saved.currentMembership || null,
            membershipStatus: createdAssignment?.effective_status || current?.membershipStatus || saved.membershipStatus || "unassigned",
            startDate: createdAssignment?.start_date || current?.startDate || record.startDate,
            expiryDate: createdAssignment?.end_date || current?.expiryDate || record.expiryDate,
            totalFees,
            emergencyContact: record.emergencyContact,
            charges: record.charges,
            renewals: record.renewals,
            followUpStatus: record.followUpStatus
        };
        const targetIndex = state.members.findIndex((member) => member.id === normalized.id);
        if (targetIndex >= 0) state.members[targetIndex] = normalized;
        else state.members.unshift(normalized);
        if (createdAssignment) setMemberCurrentMembership(normalized.id, createdAssignment);
    }

    // Consent changes go through their own endpoint so the database records them in the history.
    await recordFormConsent(saved.id, record.whatsappOptIn);

    if (initialPayment > 0) {
        const payment = await createPayment({
            member_id: saved.id,
            membership_id: createdAssignment?.id || null,
            amount: initialPayment,
            paid_on: localISODate(),
            method: "upi",
            note: "Initial payment"
        });
        if (!payment) throw new Error("The payments API did not return the initial payment.");
        const mappedPayment = mapPayment(payment);
        addPaidAmount(saved.id, mappedPayment.amount);
        state.apiMemberPayments[saved.id] = [
            mappedPayment,
            ...(state.apiMemberPayments[saved.id] || []).filter((item) => item.id !== mappedPayment.id)
        ];
    }

    if (isNewMember) {
        await finishMemberSave(saved.id, "New member added and plan assigned.");
        return;
    }
    closeModal();
    safePersist("Member details updated.");
}

async function savePayment(form) {
    const values = new FormData(form);
    const member = getMember(String(values.get("memberId") || ""));
    if (!member) throw new Error("Select a valid member.");
    const amount = Number(values.get("amount"));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Payment amount must be greater than zero.");
    const saved = await createPayment({
        member_id: member.id,
        membership_id: form.dataset.membershipId || null,
        amount,
        method: String(values.get("method")),
        paid_on: String(values.get("date")),
        note: String(values.get("notes") || "").trim() || null
    });
    if (!saved) throw new Error("The payments API did not return the saved record.");
    const mapped = mapPayment(saved);
    if (member.memberCode) addPaidAmount(member.id, mapped.amount);
    state.apiMemberPayments[member.id] = [mapped, ...(state.apiMemberPayments[member.id] || []).filter((item) => item.id !== mapped.id)];
    closeModal();
    safePersist("Payment recorded successfully.");
    if (currentView === "profile" && profileId === member.id) render();
}

function saveRenewal(form) {
    const member = getMember(form.dataset.id);
    if (!member) throw new Error("Member was not found.");
    const values = new FormData(form);
    const plan = getPlan(String(values.get("planId") || ""));
    if (!plan || !plan.active) throw new Error("Choose an active membership plan.");
    const amount = Number(values.get("amount"));
    if (!Number.isFinite(amount) || amount < 0 || amount > plan.price) throw new Error("Payment must be between zero and the plan price.");
    const startDate = String(values.get("startDate"));
    const expiryDate = String(values.get("expiryDate"));
    if (!startDate || !expiryDate || expiryDate < startDate) throw new Error("Enter a valid membership date range.");
    const renewal = { date: localISODate(), previousExpiryDate: member.expiryDate, planId: plan.id, startDate, expiryDate, amount };
    member.renewals = [...(member.renewals || []), renewal];
    member.charges = [...(member.charges || [{ amount: Number(member.totalFees || 0), date: member.startDate }]), { amount: plan.price, date: localISODate() }];
    member.planId = plan.id;
    member.startDate = startDate;
    member.expiryDate = expiryDate;
    member.totalFees = Number(member.totalFees || 0) + plan.price;
    member.status = "active";
    if (amount > 0) state.payments.unshift({ id: uid("TX"), memberId: member.id, amount, date: localISODate(), method: String(values.get("method")), status: "paid", notes: "Membership renewal" });
    closeModal(); safePersist("Membership renewed.");
}

function recordCheckIn(form) {
    const values = new FormData(form);
    const member = getMember(String(values.get("memberId") || ""));
    if (!member) throw new Error("Select a valid member.");
    if (memberStatus(member) === "expired" && !window.confirm(`${member.name}'s membership is expired. Record this check-in anyway?`)) return;
    const today = localISODate();
    if (state.attendance.some((record) => record.memberId === member.id && record.checkedInAt.slice(0, 10) === today)) throw new Error("This member already has a check-in recorded today.");
    const source = form.dataset.source || "manual";
    state.attendance.unshift({ id: uid("AT"), memberId: member.id, checkedInAt: new Date().toISOString(), checkedOutAt: "", source });
    closeModal(); safePersist(source === "fingerprint" ? "Simulated scan matched. Attendance recorded." : "Check-in recorded.");
}

async function openImportPreview() {
    openModal({
        title: "Preview member import",
        subtitle: escapeHTML(currentFileName),
        body: `<div class="empty-state" role="status">Checking existing members and plans…</div>`,
        footer: `<button class="button button-secondary" data-action="close-modal">Cancel</button>`
    });
    let existingPhones;
    try {
        [importPlans, existingPhones] = await Promise.all([fetchActivePlans(), fetchAllMemberPhones(fetchMembers)]);
    } catch (error) {
        openModal({
            title: "Preview member import",
            subtitle: escapeHTML(currentFileName),
            body: `<div class="empty-state" role="alert"><p>${escapeHTML(error.message || "Existing members and plans could not be loaded.")}</p><button class="button button-secondary" data-action="retry-import-preview">Try again</button></div>`,
            footer: `<button class="button button-secondary" data-action="close-modal">Cancel</button>`
        });
        return;
    }
    const { valid, invalid, rows: checkedRows } = validateImportRows(importedRows, { existingPhones, activePlans: importPlans });
    importedRows = checkedRows;
    renderImportPreview(valid.length, invalid.length);
}

function renderImportPreview(validCount, invalidCount) {
    const rows = importedRows.slice(0, 30);
    openModal({
        title: "Preview member import",
        subtitle: `${escapeHTML(currentFileName)} · ${validCount} valid · ${invalidCount} invalid or duplicate`,
        wide: true,
        body: `<div class="note-box" style="margin-bottom:12px">Required columns: <strong>name</strong> and <strong>phone</strong>. An optional <strong>whatsapp_opt_in</strong> column records consent only for rows marked yes. Supported aliases include full name, mobile, phone number, joining date and membership plan. Rows with an existing or repeated phone are skipped. Rows without a plan are added without a membership.</div>
        <p id="import-progress" role="status" aria-live="polite"></p>
        <div class="table-wrap"><table><thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>Plan</th><th>Validation</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${row.rowNumber}</td><td>${escapeHTML(row.name)}</td><td>${escapeHTML(formatPhone(row.phone))}</td><td>${escapeHTML(row.planName || "No plan")}</td><td>${row.issues.length ? `<span class="status status-expired">${escapeHTML(row.issues.join(", "))}</span>` : `<span class="status">Ready</span>`}</td></tr>`).join("")}</tbody></table></div>${importedRows.length > 30 ? `<p class="helper-text">Showing first 30 of ${importedRows.length} rows.</p>` : ""}`,
        footer: `<button class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary" data-action="confirm-import" ${validCount ? "" : "disabled"}>Import ${validCount} members</button>`
    });
}

async function confirmImport() {
    const rows = importedRows.filter((row) => !row.issues.length);
    if (!rows.length) return;
    const skipped = importedRows
        .filter((row) => row.issues.length)
        .map((row) => ({ rowNumber: row.rowNumber, message: row.issues.join(", ") }));
    const progress = document.querySelector("#import-progress");
    document.querySelectorAll('[data-action="confirm-import"], #modal-root [data-action="close-modal"]').forEach((button) => { button.disabled = true; });

    const result = await importMembers(rows, {
        plans: importPlans,
        createMember: createMemberOnApi,
        assignPlan: createMemberPlanAssignment,
        recordConsent: setWhatsAppConsentOnApi,
        today: localISODate(),
        onProgress: ({ current, total }) => {
            if (progress?.isConnected) progress.textContent = `Importing member ${current} of ${total}…`;
        }
    });
    if (progress?.isConnected) progress.textContent = "Refreshing the member list…";

    importedRows = [];
    importPlans = [];
    memberFilters.page = 1;
    await refreshMembersFromApi({ page: 1 });
    const errors = [...result.errors, ...skipped].sort((a, b) => a.rowNumber - b.rowNumber);
    const failureRows = errors.map((error) => `<li>Row ${error.rowNumber}: ${escapeHTML(error.message)}</li>`).join("");
    const summary = [
        `${result.imported} member${result.imported === 1 ? "" : "s"} imported`,
        result.withoutPlan ? `${result.withoutPlan} without a plan` : "",
        `${errors.length} row${errors.length === 1 ? "" : "s"} need${errors.length === 1 ? "s" : ""} attention`
    ].filter(Boolean).join(" · ");
    openModal({
        title: "Member import complete",
        body: `<p role="status">${summary}.</p>${failureRows ? `<ul class="helper-text" role="alert">${failureRows}</ul>` : ""}`,
        footer: `<button class="button button-primary" type="button" data-action="close-modal">Done</button>`
    });
}

function exportMembers() {
    runExport("members.csv", state.members.map((member) => ({
        memberId: member.id, name: member.name, phone: member.phone, email: member.email || "", joinedAt: member.joinedAt,
        plan: getPlan(member.planId)?.name || "", startDate: member.startDate, expiryDate: member.expiryDate,
        status: memberStatus(member), totalFees: member.totalFees, amountPaid: member.totalFees - memberBalance(member), outstanding: memberBalance(member)
    })));
}

function exportPayments() {
    runExport("payments.csv", state.payments.map((payment) => ({ ...payment, memberName: getMember(payment.memberId)?.name || "Removed member" })));
}

function exportRenewals() {
    runExport("renewals.csv", state.members.flatMap((member) => (member.renewals || []).map((renewal) => ({ memberId: member.id, memberName: member.name, ...renewal }))));
}

function exportRetention() {
    const rows = state.members.map((member) => {
        const last = state.attendance.filter((record) => record.memberId === member.id).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt))[0];
        const daysInactive = last ? daysBetween(last.checkedInAt.slice(0, 10)) : "";
        return { memberId: member.id, name: member.name, phone: member.phone, lastVisit: last?.checkedInAt.slice(0, 10) || "", daysInactive, expiryDate: member.expiryDate, followUpStatus: member.followUpStatus || "pending" };
    }).filter((row) => row.daysInactive === "" || row.daysInactive >= 7);
    runExport("retention-followups.csv", rows);
}

function exportAnalytics() {
    runExport("analytics-summary.csv", [
        { metric: "totalMembers", value: state.members.length },
        { metric: "activeMembers", value: state.members.filter((member) => memberStatus(member) === "active").length },
        { metric: "allTimeCollected", value: state.payments.filter((payment) => payment.status === "paid").reduce((sum, payment) => sum + Number(payment.amount), 0) },
        { metric: "outstanding", value: state.members.reduce((sum, member) => sum + memberBalance(member), 0) },
        { metric: "attendanceRecords", value: state.attendance.length }
    ]);
}

function downloadReport() {
    const type = document.querySelector("#report-type")?.value;
    const date = document.querySelector("#report-date")?.value || localISODate();
    let rows = [];
    let filename = `${type || "report"}.csv`;
    if (type === "attendance-daily" || type === "attendance-monthly") {
        rows = state.attendance.filter((record) => type === "attendance-daily" ? record.checkedInAt.slice(0, 10) === date : record.checkedInAt.slice(0, 7) === localISODate().slice(0, 7)).map((record) => ({ memberId: record.memberId, memberName: getMember(record.memberId)?.name || "Removed member", phone: getMember(record.memberId)?.phone || "", checkedInAt: record.checkedInAt, checkedOutAt: record.checkedOutAt || "", source: record.source }));
    } else if (type === "revenue") rows = state.payments.filter((payment) => payment.status === "paid").map((payment) => ({ ...payment, memberName: getMember(payment.memberId)?.name || "Removed member" }));
    else if (type === "outstanding") rows = state.members.filter((member) => memberBalance(member) > 0).map((member) => ({ memberId: member.id, name: member.name, phone: member.phone, outstanding: memberBalance(member) }));
    else if (type === "memberships") rows = state.members.map((member) => ({ memberId: member.id, name: member.name, plan: getPlan(member.planId)?.name || "", startDate: member.startDate, expiryDate: member.expiryDate, status: memberStatus(member) }));
    else if (type === "renewals") rows = state.members.flatMap((member) => (member.renewals || []).map((renewal) => ({ memberId: member.id, memberName: member.name, ...renewal })));
    else if (type === "inactive") rows = state.members.filter((member) => {
        const last = state.attendance.filter((record) => record.memberId === member.id).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt))[0];
        return !last || daysBetween(last.checkedInAt.slice(0, 10)) >= 14;
    }).map((member) => ({ memberId: member.id, name: member.name, phone: member.phone, expiryDate: member.expiryDate }));
    runExport(filename, rows);
}

function runExport(filename, rows) {
    try {
        downloadCSV(filename, rows);
        toast(`${filename} downloaded.`);
    } catch (error) {
        toast(error.message || "Unable to export CSV.", "error");
    }
}

async function copyMessage(message) {
    try {
        await navigator.clipboard.writeText(message);
        toast("Preview copied. It has not been sent.");
    } catch {
        toast("Clipboard access is unavailable in this browser.", "error");
    }
}

function resetDemoData() {
    openModal({
        title: "Clear local sample data?",
        body: `<p class="confirm-copy">This removes the fictional sample records from this browser. It does not delete members or payments in your gym database.</p>`,
        footer: `<button class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-danger" data-action="confirm-reset">Clear sample data</button>`
    });
}

function confirmReset() {
    try {
        resetDemo();
        memberFilters = { search: "", filter: "all", sort: "name" };
        currentView = "overview";
        closeModal(); render(); refreshMembersFromApi({ page: 1 }); toast("Local sample data cleared.");
    } catch (error) {
        toast(error.message || "Could not reset demo data.", "error");
    }
}

function loadSampleData() {
    try {
        const sample = createDemoState();
        const currentGym = state.gym;
        Object.keys(state).forEach((key) => delete state[key]);
        Object.assign(state, sample, {
            gym: currentGym,
            sampleDataLoaded: true,
            apiMemberPayments: {},
            whatsapp: {}
        });
        memberFilters = { search: "", filter: "all", sort: "name", page: 1 };
        persist();
        render();
        toast("Fictional sample data loaded in this browser only.");
    } catch (error) {
        toast(error.message || "Could not load sample data.", "error");
    }
}

function saveSettings(form) {
    const values = new FormData(form);
    const phone = String(values.get("phone") || "").trim();
    if (phone && (phoneDigits(phone).length < 10 || phoneDigits(phone).length > 15)) throw new Error("Enter a valid gym phone number.");
    const name = String(values.get("name") || "").trim();
    if (!name) throw new Error("Gym name is required.");
    const language = String(values.get("language") || "en");
    setLanguage(language);
    state.gym = {
        ...state.gym,
        name,
        phone,
        address: String(values.get("address") || "").trim(),
        currency: String(values.get("currency") || "INR"),
        dateFormat: String(values.get("dateFormat") || "DD MMM YYYY"),
        language,
        preferences: {
            expiryReminderDays: Math.max(0, Math.min(90, Number(values.get("expiryReminderDays") || 0))),
            paymentReminders: values.has("paymentReminders"),
            inactivityReminders: values.has("inactivityReminders")
        }
    };
    safePersist("Settings saved.");
}

async function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === "login-form") {
        event.preventDefault();
        const errorElement = document.querySelector("#auth-error");
        errorElement.hidden = true;
        try {
            const result = await apiClient.post("/api/auth/login", {
                email: form.elements.email.value.trim(),
                password: form.elements.password.value
            });
            acceptSession(result.data);
        } catch (error) {
            errorElement.textContent = error.message || "Sign in failed.";
            errorElement.hidden = false;
        }
        return;
    }
    if (form.id === "create-gym-form") {
        event.preventDefault();
        const errorElement = document.querySelector("#gym-error");
        errorElement.hidden = true;
        try {
            const result = await apiClient.post("/api/auth/gym", { name: form.elements.name.value.trim() });
            activeSession = { ...activeSession, gym: result.data.gym };
            startAuthenticatedApp(activeSession);
        } catch (error) {
            errorElement.textContent = error.message || "The gym could not be created.";
            errorElement.hidden = false;
        }
        return;
    }
    if (form.id === "membership-assignment-form") {
        event.preventDefault();
        await submitMembershipAssignment(form, render);
        return;
    }
    if (form.id === "plan-form") {
        event.preventDefault();
        await handlePlanSubmit(form, renderPlansIfCurrent);
        return;
    }
    if (form.id === "welcome-template-form") {
        event.preventDefault();
        await handleWelcomeTemplateSubmit(form);
        return;
    }
    if (form.id === "whatsapp-compose" || form.id === "whatsapp-template-form" || form.id === "whatsapp-click-template-form") {
        event.preventDefault();
        if (!form.reportValidity()) return;
        handleWhatsAppSubmit(form, render);
        return;
    }
    const handlers = {
        "member-form": saveMember,
        "quick-member-form": saveQuickMember,
        "payment-form": savePayment,
        "renew-form": saveRenewal,
        "checkin-form": recordCheckIn,
        "settings-form": saveSettings
    };
    const handler = handlers[form.id];
    if (!handler) return;
    event.preventDefault();
    if (form.id === "member-form" || form.id === "quick-member-form") {
        const nameValid = validateMemberName(form, true);
        const phoneValid = validateMemberPhone(form, true);
        if (!nameValid || !phoneValid) return;
    }
    if (!form.reportValidity()) return;
    if (form.id === "member-form" || form.id === "quick-member-form") {
        if (memberSaving) return;
        memberSaving = true;
        form.dataset.submitting = "true";
        const submitButton = document.querySelector(`[type="submit"][form="${form.id}"]`);
        if (submitButton) submitButton.disabled = true;
        try {
            await handler(form);
        } catch (error) {
            if (error?.stage === "consent") {
                const errorElement = form.querySelector(form.id === "quick-member-form" ? "#quick-assignment-error" : "#member-assignment-error");
                if (errorElement) {
                    errorElement.textContent = error.message;
                    errorElement.hidden = false;
                }
                if (submitButton) submitButton.textContent = "Retry saving consent";
                toast(error.message, "error");
            } else if (form.id === "quick-member-form" && form.dataset.createdMemberId) {
                const assignmentError = form.querySelector("#quick-assignment-error");
                const message = `Member saved, but plan assignment failed: ${error.message || "Please retry."} Use the button to retry without creating another member.`;
                if (assignmentError) {
                    assignmentError.textContent = message;
                    assignmentError.hidden = false;
                }
                if (submitButton) submitButton.textContent = "Retry plan assignment";
                toast(message, "error");
            } else if (form.id === "member-form" && form.dataset.createdMemberId && form.dataset.assignmentPending === "true") {
                const assignmentError = form.querySelector("#member-assignment-error");
                const message = `Member was saved, but plan assignment failed: ${error.message || "Please retry."} The form will retry assignment without creating another member.`;
                if (assignmentError) {
                    assignmentError.textContent = message;
                    assignmentError.hidden = false;
                }
                toast(message, "error");
            } else {
                toast(error.message || "Please check the form and try again.", "error");
            }
        } finally {
            memberSaving = false;
            form.dataset.submitting = "false";
            if (submitButton?.isConnected) {
                submitButton.disabled = form.dataset.plansState !== "ready";
            }
        }
        return;
    }
    try {
        await handler(form);
    } catch (error) {
        toast(error.message || "Please check the form and try again.", "error");
    }
}

document.addEventListener("click", (event) => {
    // The WhatsApp link still opens normally; this only records and animates the reminder.
    const reminderLink = event.target.closest("a[data-remind-key]");
    if (reminderLink) {
        const key = markReminderSent(reminderLink);
        if (key) recordExpiryReminder(key);
        return;
    }
    const viewLink = event.target.closest("[data-view]");
    if (viewLink) { navigate(viewLink.dataset.view); return; }
    const action = event.target.closest("[data-action]");
    if (action) {
        if (action.dataset.action === "toggle-nav-more") {
            setNavMoreOpen(action.getAttribute("aria-expanded") !== "true");
            return;
        }
        if (action.dataset.action === "retry-consent-history") {
            loadProfileConsent(action.dataset.id);
            return;
        }
        if (action.dataset.action === "retry-expiring") {
            loadExpiringMemberships();
            return;
        }
        if (action.dataset.action === "retry-member-plans") {
            const form = document.querySelector("#member-form");
            if (form && form.dataset.mode === "create") loadMemberFormPlans(form);
            return;
        }
        if (action.dataset.action === "retry-quick-add-plans") {
            const form = document.querySelector("#quick-member-form");
            if (form) loadQuickAddPlans(form);
            return;
        }
        // Synchronous up to window.open / navigator.share, so phones treat it as the user's tap.
        if (action.dataset.action.startsWith("welcome-")) {
            handleWelcomeAction(action.dataset.action, action, rerenderAfterWelcome);
            return;
        }
        if (action.dataset.action.startsWith("whatsapp-")) {
            handleWhatsAppAction(action.dataset.action, action, render);
            return;
        }
        if (action.dataset.action === "confirm-reset") { confirmReset(); return; }
        if (action.dataset.action === "confirm-import") { confirmImport(); return; }
        if (action.dataset.action === "retry-import-preview") { openImportPreview(); return; }
        if (action.dataset.action === "previous-members-page" || action.dataset.action === "next-members-page") {
            const pageDelta = action.dataset.action === "next-members-page" ? 1 : -1;
            refreshMembersFromApi({ page: Math.max(1, memberFilters.page + pageDelta) });
            return;
        }
        if (handleMembershipAction(action.dataset.action, action)) return;
        if (handlePlanAction(action.dataset.action, action, renderPlansIfCurrent)) return;
        handleAction(action.dataset.action, action);
    }
});

document.addEventListener("submit", handleSubmit);
document.querySelector("#logout-button").addEventListener("click", async () => {
    try {
        await apiClient.post("/api/auth/logout", {});
    } catch (error) {
        console.error("GymPulse could not revoke the current session.", error);
        saveAuthNotice("You are signed out on this device, but the server could not revoke the session. Contact your administrator.");
    } finally {
        clearAuthSession();
        activeSession = null;
        window.location.reload();
    }
});
document.querySelector("#sign-out-onboarding").addEventListener("click", async () => {
    try {
        await apiClient.post("/api/auth/logout", {});
    } catch (error) {
        console.error("GymPulse could not revoke the current session.", error);
        saveAuthNotice("You are signed out on this device, but the server could not revoke the session. Contact your administrator.");
    } finally {
        clearAuthSession();
        activeSession = null;
        window.location.reload();
    }
});
document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches("[data-whatsapp-change]")) {
        handleWhatsAppChange(target, render);
        return;
    }
    if (handleWelcomeTemplateEvent(target)) return;
    if (target.closest("#modal-root")) updateMemberFormDefaults(target);
    if (target.id === "expiry-days") {
        expiringDays = Number(target.value);
        loadExpiringMemberships();
    }
    if (target.matches("#membership-assignment-form [name='plan_id'], #membership-assignment-form [name='start_date']")) updateAssignmentForm(target);
    if (target.id === "plan-status-filter") { setPlanStatus(target.value, renderPlansIfCurrent); return; }
    if (target.id === "form-duration_choice") { updatePlanDurationField(target); return; }
    if (target.id === "member-filter") {
        memberFilters.filter = target.value;
        memberFilters.page = 1;
        render();
        refreshMembersFromApi({ page: 1 });
    }
    if (target.id === "member-sort") { memberFilters.sort = target.value; render(); }
    if (target.id === "renewal-filter") {
        document.querySelectorAll("[data-renewal-row]").forEach((row) => {
            const days = Number(row.dataset.days);
            const value = target.value;
            row.hidden = value === "all" ? false : value === "expired" ? days >= 0 : value === "today" ? days !== 0 : value === "3" ? days < 1 || days > 3 : value === "7" ? days < 1 || days > 7 : days < 1 || days > 30;
        });
    }
    if (target.id === "payment-method-filter" || target.id === "payment-date-filter") filterPaymentRows();
    if (target.classList.contains("followup-select")) {
        const member = getMember(target.dataset.id);
        if (member) saveFollowUpStatus(member, target);
    }
});

document.addEventListener("input", (event) => {
    const target = event.target;
    if (target.id === "welcome-body") { handleWelcomeTemplateEvent(target); return; }
    if (target.matches('#member-form [name="phone"], #quick-member-form [name="phone"]')) {
        target.value = target.value.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "").slice(0, 13);
        validateMemberPhone(target.form, false);
    }
    if (target.matches('#member-form [name="name"], #quick-member-form [name="name"]')) {
        validateMemberName(target.form, target.getAttribute("aria-invalid") === "true");
    }
    if (target.matches("#membership-assignment-form [name='start_date']")) updateAssignmentForm(target);
    if (target.id === "member-search") {
        memberFilters.search = target.value;
        memberFilters.page = 1;
        clearTimeout(memberSearchTimer);
        memberSearchTimer = setTimeout(() => refreshMembersFromApi({ page: 1 }), 250);
    }
    if (target.id === "plan-search") setPlanSearch(target.value, renderPlansIfCurrent);
    if (target.id === "attendance-search") {
        const query = target.value.toLowerCase();
        document.querySelectorAll("[data-attendance-row]").forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
    }
    if (target.id === "payment-search") {
        filterPaymentRows();
    }
});

async function saveFollowUpStatus(member, select) {
    const previous = member.followUpStatus || "pending";
    select.disabled = true;
    try {
        if (member.memberCode) await updateMemberFieldsOnApi(member.id, { follow_up_status: select.value });
        else member.followUpStatus = select.value;
        safePersist("Follow-up status updated.");
    } catch (error) {
        select.value = previous;
        toast(error.message || "Follow-up status could not be saved.", "error");
    } finally {
        if (select.isConnected) select.disabled = false;
    }
}

function validateMemberName(form, showError) {
    const input = form?.elements?.name;
    const error = form?.querySelector(".name-error");
    if (!input || !error) return true;
    const issue = memberNameIssue(input.value);
    error.textContent = issue ? MEMBER_NAME_MESSAGES[issue] : "";
    error.hidden = !issue || !showError;
    input.setAttribute("aria-invalid", String(Boolean(issue) && showError));
    return !issue;
}

function validateMemberPhone(form, showError) {
    const input = form?.elements?.phone;
    const error = form?.querySelector(".phone-error");
    if (!input || !error) return true;
    const valid = isValidIndianPhone(input.value);
    error.hidden = valid || !showError;
    input.setAttribute("aria-invalid", String(!valid && showError));
    return valid;
}

document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target.matches?.('#member-form [name="phone"], #quick-member-form [name="phone"]')
        && !event.ctrlKey && !event.metaKey && !event.altKey
        && event.key.length === 1
        && !/[0-9]/.test(event.key)
        && !(event.key === "+" && target.value.length === 0)) {
        event.preventDefault();
    }
});

function filterPaymentRows() {
    const query = (document.querySelector("#payment-search")?.value || "").toLowerCase();
    const method = document.querySelector("#payment-method-filter")?.value || "all";
    const date = document.querySelector("#payment-date-filter")?.value || "";
    document.querySelectorAll("[data-payment-row]").forEach((row) => {
        row.hidden = !row.textContent.toLowerCase().includes(query)
            || (method !== "all" && row.dataset.method !== method)
            || (date && row.dataset.date !== date);
    });
}

function openMobileMenu() {
    document.querySelector("#sidebar").classList.add("open");
    document.querySelector("#mobile-scrim").classList.add("visible");
    document.querySelector("#mobile-menu").setAttribute("aria-expanded", "true");
}

document.querySelector("#mobile-menu").addEventListener("click", openMobileMenu);
document.querySelector("#mobile-scrim").addEventListener("click", closeMobileMenu);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.querySelector("#sidebar").classList.contains("open")) {
        closeMobileMenu();
        document.querySelector("#mobile-menu").focus();
    }
    if (event.key === "Escape") document.querySelector(".wa-inbox.show-thread .wa-back")?.click();
});
document.querySelector("#csv-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
        currentFileName = file.name;
        importedRows = parseCSV(await file.text());
        openImportPreview();
    } catch (error) {
        toast(error.message || "Unable to read this CSV file.", "error");
    }
});

async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
        await navigator.serviceWorker.register("/sw.js");
    } catch (error) {
        console.error("GymPulse could not register its service worker.", error);
        toast("Offline app setup failed. The app will still work while online.", "error");
    }
}

registerServiceWorker();
setUnauthorizedHandler(() => {
    clearAuthSession();
    activeSession = null;
    saveAuthNotice("Your session expired. Please sign in again.");
    window.location.reload();
});
async function restoreSessionOnLoad() {
    try {
        const session = await restoreAuthSession();
        if (session) acceptSession(session);
        else showAuthScreen(false, takeAuthNotice());
    } catch (error) {
        showAuthScreen(false, error.message || "Your saved session could not be restored.");
    }
}

restoreSessionOnLoad();
