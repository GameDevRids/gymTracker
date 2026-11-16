import {
    state,
    getMember,
    memberBalance,
    addPaidAmount,
    startWorkspace,
    loadAllMembersFromApi,
    createMemberOnApi,
    updateMemberOnApi,
    updateMemberFieldsOnApi,
    reloadMemberFromApi,
    ensureMember,
    setWhatsAppConsentOnApi,
    loadConsentHistory,
    deleteMemberOnApi
} from "./state.js";
import { renderDashboard, drawDashboardCharts } from "./modules/dashboard.js";
import { MEMBERS_PAGE_SIZE, filterMembers, renderMemberResults, renderMembers, renderProfile } from "./modules/members.js";
import { renderPlansPage, loadPlans, setPlanSearch, setPlanStatus, handlePlanAction, handlePlanSubmit, updatePlanDurationField } from "./modules/plans.js";
import {
    handleMembershipAction,
    loadAllMemberships,
    loadMemberMembershipHistory,
    getCurrentMembership,
    planNameFor,
    renewalMemberships,
    setMemberCurrentMembership,
    submitMembershipAssignment,
    updateAssignmentForm
} from "./modules/memberMemberships.js";
import { fetchActivePlans } from "./api/plansApi.js";
import { handleImportAction, handleImportChange, handleImportFile, openMemberImport } from "./modules/memberImportUi.js";
import { createMemberPlanAssignment, fetchMemberMembershipHistory } from "./api/membershipsApi.js";
import { createPayment, fetchMemberPayments } from "./api/paymentsApi.js";
import { apiClient, clearAuthSession, ensureFreshSession, restoreAuthSessionWithRetry, setAuthSession, setUnauthorizedHandler } from "./api/apiClient.js";
import { markReminderSent, reminderKey, renderExpiring } from "./modules/expiring.js";
import { renderOperationsPage, drawAnalyticsCharts, retentionRows } from "./modules/operations.js";
import { openModal, closeModal } from "./components/modal.js";
import { toast } from "./components/toast.js";
import { applyNavigationTranslations, isSupportedLanguage, setLanguage, t } from "./i18n.js";
import { loadWelcomeFacts, loadWelcomeLog, loadWelcomeTemplates, welcomeBlocker } from "./modules/welcome.js";
import { handleUpiPaymentAction, loadGymSettings, loadPaymentsPage, methodLabel, openReceiptDialog, renderUpiTestQr, saveGymSettingsOnApi, updatePaymentQrPanel, whenGymSettingsApplied } from "./modules/upiPayments.js";
import { upiIdProblem, UTR_PATTERN } from "./upi.js";
import { welcomePayment } from "./welcomeMessage.js";
import { handleAttendanceAction, loadAttendanceFeed, loadMemberAttendance, loadMemberDevices, manualCheckIn, openCheckInByName, pauseCheckinForPhoto, renderCheckInPage, searchCheckInMembers, selectVisitsDay, startCheckInScreen, stopCheckInScreen, watchApprovals } from "./modules/attendance.js";
import { handleCheckinSettingsAction, loadCheckinSettings, saveAttendanceSettings } from "./modules/checkinSettingsUi.js";
import { editPhotoField, handlePhotoAction, hydratePhotos, loadProfilePhoto, mountEditPhoto, mountFormPhoto, photoFormField, saveFormPhoto } from "./modules/memberPhotos.js";
import { usesMemberQr } from "./modules/checkinMethod.js";
import { handleWelcomeAction, handleWelcomeTemplateEvent, handleWelcomeTemplateSubmit, openMemberAddedDialog } from "./modules/welcomeUi.js";
import { expiryReminderTemplate, handleReminderTemplateAction, handleReminderTemplateEvent, handleReminderTemplateSubmit, loadReminderTemplates, recordExpiryReminder } from "./modules/expiryReminder.js";
import { currentSummary, loadSummary } from "./modules/summary.js";
import { forgetEmptyLocalData, handleLocalDataAction, localDataToMove, openLocalDataDialog } from "./modules/localData.js";
import { escapeHTML, localISODate, indiaISODate, addDays, formatINR, formatDate, formatPlanDuration, downloadCSV, isValidIndianPhone, normalizeIndianPhone, cleanMemberName, memberNameIssue, MEMBER_NAME_MESSAGES, setDateFormat, visitDay } from "./utils.js";
import { readUiPreferences, saveUiPreferences } from "./storage.js";
import { bindAuthPasswordLinks, checkAccountBeforeApp, downloadGymWorkbook, handleAuthPasswordSubmit, handleTermsSubmit, openDeleteGymDialog, reportProblemUrl, setAccountEmail, startPasswordResetIfLinked, submitChangePassword, submitDeleteGym } from "./modules/account.js";
import { APP_VERSION } from "./version.js";
import { startErrorReporting } from "./errorReporting.js";
import { handleRenewSubmit, openRenewSheet } from "./modules/renewSheet.js";
import { hideSetupChecklist, loadSetupPlans } from "./modules/setupChecklist.js";

const page = document.querySelector("#page-content");
const viewTitles = {
    expiring: "Expiring soon", overview: "Overview", members: "Members", plans: "Membership plans", attendance: "Attendance", payments: "Payments",
    renewals: "Renewals", retention: "Retention", analytics: "Analytics", reports: "Reports",
    notifications: "Notifications", integrations: "Integrations", settings: "Settings", profile: "Member profile", scan: "Check-in"
};
// Conveniences remembered in this browser (storage.js): the last page, member filters and the
// Expiring soon window. Everything else comes from the database.
const uiPreferences = readUiPreferences();
const MEMBER_FILTERS = ["all", "active", "upcoming", "expired", "cancelled", "unassigned", "suspended"];
const MEMBER_SORTS = ["name", "expiry", "joined"];
let currentView = viewTitles[uiPreferences.view] && uiPreferences.view !== "profile" ? uiPreferences.view : "expiring";
let profileId = "";
let memberFilters = {
    search: "",
    filter: MEMBER_FILTERS.includes(uiPreferences.memberFilter) ? uiPreferences.memberFilter : "all",
    sort: MEMBER_SORTS.includes(uiPreferences.memberSort) ? uiPreferences.memberSort : "name",
    page: 1
};
let memberRequestVersion = 0;
let memberPlanRequest = 0;
let memberSaving = false;
let expiringDays = [3, 7, 15, 30].includes(uiPreferences.expiringDays) ? uiPreferences.expiringDays : 7;
let expiringMemberships = [];
let expiringStatus = "loading";
// "loading" until every member has loaded after sign-in, so the list shows skeletons, not "No members yet".
let membersStatus = "loading";
let expiringRequestVersion = 0;
let activeSession;
let localDataOffered = false;
let profileLoading = "";

function showAuthScreen(onboarding = false, message = "") {
    document.querySelector("#auth-screen").hidden = false;
    document.querySelector("#app-shell").hidden = true;
    document.querySelector(".mobile-bottom-nav").hidden = true;
    document.querySelector("#login-form").hidden = onboarding;
    document.querySelector("#forgot-password-form").hidden = true;
    document.querySelector("#reset-password-form").hidden = true;
    document.querySelector("#terms-form").hidden = true;
    document.querySelector("#deletion-pending").hidden = true;
    document.querySelector("#connecting-panel").hidden = true;
    document.querySelector("#auth-description").hidden = false;
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

// The gym's language and date format, saved in the database; applied at sign-in and on change.
function applyGymPreferences({ language, date_format: dateFormat } = {}) {
    if (isSupportedLanguage(language)) {
        setLanguage(language);
        state.gym.language = language;
    }
    if (dateFormat) state.gym.dateFormat = dateFormat;
    setDateFormat(state.gym.dateFormat);
}

function startAuthenticatedApp(session) {
    activeSession = session;
    setAccountEmail(session.user?.email);
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
    state.gym.id = session.gym.id;
    state.gym.isDemo = session.gym.is_demo === true;
    // The owner can import members; other roles cannot (the server checks too).
    state.gym.role = session.gym.role || "owner";
    applyGymPreferences(session.gym);
    render();
    refreshMembersFromApi();
    loadExpiringMemberships();
    loadSummary(rerenderSummaryViews);
    loadSetupPlans(() => { if (currentView === "overview") render(); });
    // Loaded early so the "Member added" dialog and Expiring soon can open WhatsApp without waiting.
    loadWelcomeTemplates();
    loadReminderTemplates().then(() => { if (["expiring", "settings"].includes(currentView)) render(); });
    loadAttendanceFeed(rerenderAttendanceViews);
    // The gym's one check-in method decides what the Check-in screen, profile and cards show.
    loadCheckinSettings().then(() => {
        rerenderForCheckinMethod();
        watchApprovals(() => { if (["scan", "profile"].includes(currentView)) render(); });
    });
    // Gym phone, address, UPI details and preferences live in the database.
    whenGymSettingsApplied((settings) => applyGymPreferences(settings));
    loadGymSettings().then(() => {
        if (currentView === "settings") render();
        offerLocalDataMove();
    });
    loadAllMemberships(() => {
        if (["overview", "members", "renewals", "retention", "notifications"].includes(currentView)) render();
    });
    loadPaymentsPage(() => { if (["payments", "overview", "notifications"].includes(currentView)) render(); });
}

// Once per page load: an older version's data still in this browser is offered for the move.
function offerLocalDataMove() {
    forgetEmptyLocalData();
    if (localDataOffered || !localDataToMove()?.any) return;
    localDataOffered = true;
    if (!document.querySelector("#modal-root .modal")) openLocalDataDialog();
}

// After "Move my saved data to the cloud": reload what the move changed.
function afterLocalDataMove() {
    loadGymSettings().then(() => render());
    loadReminderTemplates({ force: true }).then(() => render());
    loadExpiringMemberships();
    loadAttendanceFeed(rerenderAttendanceViews);
    render();
}

function acceptSession(session) {
    startWorkspace(session.user.id);
    setAuthSession(session);
    activeSession = session;
    // Terms first (once per version), then the app, or the "scheduled for deletion" screen.
    checkAccountBeforeApp(session, () => {
        if (!session.gym) showAuthScreen(true);
        else startAuthenticatedApp(session);
    });
}

// Pages that show gym-wide totals redraw when they arrive.
function rerenderSummaryViews() {
    if (["overview", "analytics", "payments"].includes(currentView)) render();
}

// After a renewal is saved: the member leaves Expiring soon at once when the new plan covers them
// (the server's list follows), and the plans, totals, balance and payments are reloaded.
function afterRenewal(result) {
    const memberId = result.membership.member_id;
    if (result.membership.end_date >= indiaISODate()) {
        expiringMemberships = expiringMemberships.filter((item) => item.member?.id !== memberId);
    }
    refreshTotals(memberId);
    loadAllMemberships(() => render());
    loadExpiringMemberships();
    loadPaymentsPage(() => { if (["payments", "overview"].includes(currentView)) render(); });
    render();
}

// Totals, the member's balance and the payments list change after payments, plans and archives.
function refreshTotals(memberId = "") {
    loadSummary(rerenderSummaryViews);
    if (memberId) reloadMemberFromApi(memberId).then(() => { if (["profile", "members", "renewals"].includes(currentView)) render(); }).catch(() => {});
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
        notes: payment.note || "",
        receiptNumber: payment.receipt_number || "",
        upiReference: payment.upi_reference || ""
    };
}

// "Reminded" marks come from the database: each expiring row has reminded_at for its end date.
function remindedKeys() {
    return new Set(expiringMemberships.filter((membership) => membership.reminded_at).map((membership) => reminderKey(membership)));
}

function render() {
    setDateFormat(state.gym.dateFormat || "DD MMM YYYY");
    applyNavigationTranslations();
    document.querySelectorAll(".nav-link[data-view]").forEach((link) => link.classList.toggle("active", link.dataset.view === currentView));
    // Keep the active page visible: open "More" whenever the current page lives inside it.
    if (document.querySelector(`#nav-more [data-view="${currentView}"]`)) setNavMoreOpen(true);
    const mobilePrimaryViews = ["expiring", "members", "scan", "attendance"];
    document.querySelectorAll(".mobile-nav-link[data-view]").forEach((link) => {
        const active = link.dataset.view === currentView;
        link.classList.toggle("active", active);
        link.setAttribute("aria-current", active ? "page" : "false");
    });
    document.querySelector('[data-action="mobile-more"]')?.classList.toggle("active", !mobilePrimaryViews.includes(currentView));
    const translatedViews = ["expiring", "overview", "members", "plans", "attendance", "payments", "renewals", "retention", "analytics", "reports", "notifications", "integrations", "settings"];
    document.querySelector("#current-page").textContent = translatedViews.includes(currentView) ? t(currentView) : viewTitles[currentView] || "Overview";
    document.querySelector("#member-count").textContent = membersStatus === "ready" ? state.members.length : "";
    document.querySelector("#gym-name-label").textContent = state.gym.name;
    document.querySelector(".gym-avatar").textContent = state.gym.name.trim().slice(0, 1).toUpperCase() || "G";
    const now = new Date();
    document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(now);
    if (currentView === "expiring") {
        page.innerHTML = renderExpiring(expiringMemberships, expiringStatus, expiringDays, expiryReminderTemplate(), remindedKeys());
    } else if (currentView === "overview") {
        page.innerHTML = renderDashboard();
        drawDashboardCharts();
    } else if (currentView === "members") {
        page.innerHTML = renderMembers({ ...memberFilters, loading: membersStatus === "loading" });
    } else if (currentView === "plans") {
        page.innerHTML = renderPlansPage();
    } else if (currentView === "profile") {
        page.innerHTML = profileLoading === profileId && !getMember(profileId)
            ? `<div class="empty-state" role="status">Loading member…</div>`
            : renderProfile(profileId);
    } else if (currentView === "scan") {
        // The camera keeps running across re-renders, so the member-QR page is drawn once;
        // the poster front desk is redrawn whenever approvals or today's check-ins change.
        const cameraPage = usesMemberQr();
        if (!cameraPage || !page.querySelector("#scanner-root")) page.innerHTML = renderCheckInPage();
        startCheckInScreen(rerenderCheckIn);
    } else {
        page.innerHTML = renderOperationsPage(currentView);
        if (currentView === "analytics") drawAnalyticsCharts();
    }
    // Member photos load after the page is drawn, from short-lived signed URLs.
    hydratePhotos(page);
}

// After a photo is added, changed, removed, approved or rejected.
function rerenderAfterPhoto(memberId) {
    if (currentView === "profile" && profileId === memberId) {
        loadProfilePhoto(memberId, () => { if (currentView === "profile" && profileId === memberId) render(); });
        loadProfileConsent(memberId);
    } else if (currentView === "scan") {
        rerenderCheckIn();
    } else {
        render();
    }
}

// Loads every member of the gym, so every page covers the whole gym.
async function refreshMembersFromApi({ silent = false } = {}) {
    const requestVersion = ++memberRequestVersion;
    try {
        await loadAllMembersFromApi();
        if (requestVersion !== memberRequestVersion) return;
        membersStatus = "ready";
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

function updateMemberCount() {
    const badge = document.querySelector("#member-count");
    if (badge) badge.textContent = state.members.length;
}

// Typing in the search box redraws only the results, so the box keeps its focus.
function renderMembersResults() {
    const results = document.querySelector("#members-results");
    if (currentView !== "members" || !results || membersStatus === "loading") return render();
    results.innerHTML = renderMemberResults(memberFilters);
    hydratePhotos(results);
}

// Pages that read check-ins redraw when the database feed arrives.
function rerenderAttendanceViews() {
    if (["attendance", "overview", "retention", "analytics", "notifications", "profile"].includes(currentView)) render();
    else if (currentView === "scan") rerenderCheckIn();
}

function rerenderCheckIn() {
    if (currentView === "scan") render();
}

// After the check-in method loads or changes: a running camera stops if the gym no longer
// uses member QR cards, and every page drops what belongs to the other method.
function rerenderForCheckinMethod() {
    if (currentView === "scan") {
        stopCheckInScreen();
        page.innerHTML = "";
    }
    render();
    if (currentView === "profile" && profileId) loadMemberDevices(profileId, () => { if (currentView === "profile") render(); });
}

function navigate(view) {
    if (!viewTitles[view]) return;
    if (currentView === "scan" && view !== "scan") stopCheckInScreen();
    currentView = view;
    if (view !== "profile") profileId = "";
    saveUiPreferences({ view });
    if (view === "overview") loadSetupPlans(() => { if (currentView === "overview") render(); });
    render();
    if (view === "expiring") loadExpiringMemberships();
    if (view === "plans") loadPlans(renderPlansIfCurrent);
    if (["overview", "analytics", "payments"].includes(view)) loadSummary(rerenderSummaryViews);
    if (view === "settings") {
        const renderSettings = () => { if (currentView === "settings") render(); };
        loadWelcomeTemplates({ force: true }).then(renderSettings);
        loadReminderTemplates({ force: true }).then(renderSettings);
        loadGymSettings().then(renderSettings);
        loadCheckinSettings().then(renderSettings);
    }
    if (view === "attendance") loadAttendanceFeed(rerenderAttendanceViews);
    if (["payments", "notifications"].includes(view)) loadPaymentsPage(() => { if (currentView === view) render(); });
    if (view === "profile" && profileId && !getMember(profileId)) {
        // A member who is not loaded yet (for example just added on another phone).
        const wanted = profileId;
        profileLoading = wanted;
        render();
        ensureMember(wanted)
            .catch((error) => toast(error.message || "This member could not be loaded.", "error"))
            .finally(() => {
                if (profileLoading === wanted) profileLoading = "";
                if (currentView === "profile" && profileId === wanted) navigate("profile");
            });
    } else if (view === "profile" && profileId) {
        loadMemberMembershipHistory(profileId);
        loadMemberPaymentsFromApi(profileId);
        loadProfileConsent(profileId);
        loadProfileWelcome(profileId);
        const photoFor = profileId;
        loadProfilePhoto(photoFor, () => { if (currentView === "profile" && profileId === photoFor) render(); });
        const visitsFor = profileId;
        loadMemberDevices(visitsFor, () => { if (currentView === "profile" && profileId === visitsFor) render(); });
        loadMemberAttendance(visitsFor, () => { if (currentView === "profile" && profileId === visitsFor) render(); });
    }
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
        // renderExpiring shows an object status as an error message with "Try again".
        expiringStatus = { message: error.message || "Unable to load expiring memberships." };
    }
    if (currentView === "expiring") render();
}

/**
 * "Remind on WhatsApp": WhatsApp opens through the link itself; this marks the card and logs the
 * reminder for the membership's current end date, so every device shows it as reminded.
 */
async function recordReminderClick(link) {
    const key = markReminderSent(link);
    if (!key) return;
    const membership = expiringMemberships.find((row) => reminderKey(row) === key);
    if (membership) membership.reminded_at = new Date().toISOString();
    try {
        const message = new URL(link.href).searchParams.get("text") || "";
        await recordExpiryReminder({ memberId: link.dataset.memberId, membershipId: link.dataset.membershipId, body: message });
    } catch (error) {
        toast(`WhatsApp was opened, but the reminder was not saved: ${error.message || "please try again"}`, "error");
    }
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

// Redraws after a change that is already saved in the database, with an optional message.
function safePersist(message = "Changes saved.") {
    render();
    if (message) toast(message);
}

function setField(name, label, value = "", type = "text", required = false, extra = "") {
    return `<div class="field"><label for="form-${name}">${label}${required ? " *" : ""}</label><input id="form-${name}" name="${name}" type="${type}" value="${escapeHTML(value)}" ${required ? "required" : ""} ${extra}></div>`;
}

function memberPlanOptions(plans, selected = "") {
    return plans.map((plan) => `<option value="${escapeHTML(plan.id)}" data-name="${escapeHTML(plan.name)}" data-price="${Number(plan.price)}" data-days="${Number(plan.duration_days)}" ${plan.id === selected ? "selected" : ""}>${escapeHTML(plan.name)} — ${escapeHTML(formatPlanDuration(plan.duration_days))} — ${formatINR(plan.price)}</option>`).join("");
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
            ${isEdit ? editPhotoField(member) : ""}
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
            ${!isEdit ? photoFormField("form") : ""}
            <div class="field full"><label for="form-notes">Notes</label><textarea id="form-notes" name="notes">${escapeHTML(member?.notes || "")}</textarea></div>
            <p class="helper-text field full">Each member needs their own phone number.</p>
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
    if (isEdit) {
        // The photo is saved on its own, so Save and Cancel here do not affect it.
        mountEditPhoto(form, rerenderAfterPhoto);
    } else {
        loadMemberFormPlans(form);
        mountFormPhoto(form);
    }
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
            ${photoFormField("quick")}
            <p class="helper-text" id="quick-assignment-error" role="alert" hidden></p>
        </form>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">${t("cancel")}</button><button class="button button-primary" type="submit" form="quick-member-form" disabled>${t("addAssign")}</button>`
    });
    loadQuickAddPlans(document.querySelector("#quick-member-form"));
    mountFormPhoto(document.querySelector("#quick-member-form"));
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
        updateMemberCount();
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
    await saveFormPhoto(form, member.id);
    const error = form.querySelector("#quick-assignment-error");
    if (error) error.hidden = true;
    refreshTotals(member.id);
    await finishMemberSave(member.id, "Member added and plan assigned.");
}

async function openPaymentForm(memberId = "", membershipId = "", suggestedAmount = "") {
    let member = memberId ? getMember(memberId) : null;
    if (!member && memberId) {
        // Not loaded yet (for example Record payment on Expiring soon right after sign-in):
        // read the whole member from the database instead of guessing from the list row.
        try {
            member = await ensureMember(memberId);
        } catch (error) {
            return toast(error.message || "Member was not found.", "error");
        }
    }
    if (memberId && !member) return toast("Member was not found.", "error");
    const membership = member ? getCurrentMembership(member.id) || member.currentMembership : null;
    const choices = [...state.members].sort((a, b) => a.name.localeCompare(b.name)).map((item) => `<option value="${escapeHTML(item.id)}" ${member?.id === item.id ? "selected" : ""}>${escapeHTML(item.name)}${item.memberCode ? ` · ${escapeHTML(item.memberCode)}` : ""}</option>`).join("");
    // Expiring soon passes the plan price: that payment is for the renewal. Otherwise the
    // amount is filled with the balance due, read from the database.
    const renewal = suggestedAmount !== "" && suggestedAmount !== undefined && suggestedAmount !== null;
    openModal({
        title: t("recordPayment"),
        subtitle: t("paymentSubtitle"),
        body: `<form id="payment-form" class="form-grid" data-membership-id="${escapeHTML(membershipId || membership?.id || "")}" data-amount-source="${renewal ? "renewal" : "balance"}" novalidate>
            <div class="field full"><label for="form-memberId">${t("member")} *</label><select id="form-memberId" name="memberId" required><option value="">${t("selectMember")}</option>${choices}</select></div>
            <div class="field"><label for="form-amount">${t("amountCollected")} *</label><input id="form-amount" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required value="${escapeHTML(renewal ? String(Number(suggestedAmount)) : "")}" aria-describedby="payment-amount-hint"><span class="helper-text" id="payment-amount-hint" aria-live="polite">${renewal ? "Plan price for the renewal." : ""}</span></div>
            <div class="field"><label for="form-method">${t("paymentMethod")}</label><select id="form-method" name="method">${[["upi", "UPI"], ["cash", "Cash"], ["card", "Card"], ["other", "Other"]].map(([value, label]) => `<option value="${value}" ${value === "upi" ? "selected" : ""}>${label}</option>`).join("")}</select></div>
            <div class="field full" id="payment-qr-panel" aria-live="polite"></div>
            <div class="field" id="payment-utr-field"><label for="form-upiReference">UPI reference (UTR)</label><input id="form-upiReference" name="upiReference" type="text" inputmode="numeric" autocomplete="off" maxlength="12" pattern="[0-9]{12}" placeholder="12 digits, optional"><span class="helper-text">From the payer's UPI app. Stops the same payment being recorded twice.</span></div>
            ${setField("date", t("paidOn"), localISODate(), "date", true)}
            <div class="field full"><label for="form-notes">${t("note")}</label><textarea id="form-notes" name="notes" placeholder="Optional payment note"></textarea></div>
            <p class="note-box field full payment-verify-note" role="note"><strong>Check before you mark it paid.</strong> GymPulse can't see your bank or UPI app. Make sure the money has arrived before you tap Mark as paid.</p>
        </form>`,
        footer: `<button class="button button-secondary" data-action="close-modal" type="button">${t("cancel")}</button><button class="button button-primary" type="submit" form="payment-form">Mark as paid</button>`
    });
    const form = document.querySelector("#payment-form");
    refreshPaymentQr(form);
    if (member && !renewal) prefillPaymentBalance(form, member.id);
}

function paymentFormMember(form) {
    return getMember(String(form.elements.memberId?.value || ""));
}

function refreshPaymentQr(form) {
    const member = paymentFormMember(form);
    const membership = member ? getCurrentMembership(member.id) || member.currentMembership : null;
    updatePaymentQrPanel(form, { memberCode: member?.memberCode || "", planName: membership?.plan_name || "" });
}

// Fills the amount with the balance due on the membership, from the database.
async function prefillPaymentBalance(form, memberId) {
    const hint = form.querySelector("#payment-amount-hint");
    const request = String(Math.random());
    form.dataset.prefillRequest = request;
    if (hint) hint.textContent = "Checking the balance due…";
    const facts = await loadWelcomeFacts(memberId);
    if (!form.isConnected || form.dataset.prefillRequest !== request) return;
    if (facts.status !== "ready") {
        if (hint) hint.textContent = "The balance due could not be loaded. Enter the amount.";
        return;
    }
    const membership = facts.memberships.find((row) => row.id === form.dataset.membershipId)
        || facts.memberships.find((row) => row.id === getCurrentMembership(memberId)?.id);
    const payment = welcomePayment(membership, facts.payments);
    if (!membership || !payment) {
        if (hint) hint.textContent = "No membership plan is assigned, so there is no balance to fill in.";
        return;
    }
    form.dataset.membershipId = membership.id;
    if (payment.balance > 0) {
        if (form.dataset.amountTouched !== "true") form.elements.amount.value = String(payment.balance);
        if (hint) hint.textContent = `Balance due on ${membership.plan_name}: ${formatINR(payment.balance)}.`;
    } else if (hint) {
        hint.textContent = `${membership.plan_name} is paid in full.`;
    }
    refreshPaymentQr(form);
}

function onPaymentFormEdit(target) {
    const form = target.form;
    if (!form || form.id !== "payment-form") return false;
    if (target.name === "amount") form.dataset.amountTouched = "true";
    if (target.name === "memberId" && target.matches("select")) {
        const member = paymentFormMember(form);
        form.dataset.membershipId = member ? getCurrentMembership(member.id)?.id || member.currentMembership?.id || "" : "";
        form.dataset.amountTouched = "false";
        form.dataset.amountSource = "balance";
        form.elements.amount.value = "";
        if (member) prefillPaymentBalance(form, member.id);
    }
    if (target.name === "upiReference") target.value = target.value.replace(/\D/g, "").slice(0, 12);
    refreshPaymentQr(form);
    return true;
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

function handleAction(action, target) {
    const id = target.dataset.id || "";
    switch (action) {
        case "close-modal": closeModal(); break;
        case "hide-setup": hideSetupChecklist(); render(); break;
        case "sign-out": signOut(); break;
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
                    updateMemberCount();
                    refreshTotals();
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
        case "check-in":
            if (id) manualCheckIn(id, () => { rerenderAttendanceViews(); loadMemberAttendance(id, rerenderAttendanceViews); });
            else openCheckInByName();
            break;
        case "qr-check-in": navigate("scan"); break;
        // A renewal is a new plan in the database, starting after the current one ends.
        // One sheet: plan, price, new dates, payment and receipt. Saved in one transaction.
        case "renew-member": openRenewSheet(id, { onChanged: afterRenewal }); break;
        case "retry-summary": loadSummary(rerenderSummaryViews); render(); break;
        case "export-members": exportMembers(); break;
        case "export-payments": exportPayments(); break;
        case "export-renewals": exportRenewals(); break;
        case "export-retention": exportRetention(); break;
        case "export-analytics": exportAnalytics(); break;
        case "download-report": downloadReport(); break;
        case "download-workbook": downloadGymWorkbook(); break;
        case "delete-gym": openDeleteGymDialog(openModal); break;
        case "report-problem": {
            const url = reportProblemUrl({ view: currentView, version: APP_VERSION });
            if (url) window.open(url, "_blank", "noopener");
            break;
        }
        case "import-csv": openMemberImport(); break;
        case "copy-message": copyMessage(target.dataset.message || ""); break;
        // Receipts are numbered and kept by the server.
        case "receipt": openReceiptDialog(id); break;
        default: break;
    }
}

function updateMemberFormDefaults(target) {
    const form = target.closest("form");
    if (!form) return;
    if (form.id === "member-form" && form.dataset.mode === "create" && target.name === "planId") {
        const option = target.selectedOptions[0];
        form.elements.totalFees.value = option?.value ? option.dataset.price : "";
        updateMemberAssignmentPreview(form);
    }
    if (form.id === "member-form" && target.name === "assignmentStartDate") {
        updateMemberAssignmentPreview(form);
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

    const record = {
        memberCode: current?.memberCode || "",
        name,
        phone,
        email: String(values.get("email") || "").trim(),
        dob: String(values.get("dob") || ""),
        gender: String(values.get("gender") || ""),
        status: String(values.get("status") || current?.status || "active"),
        emergencyContact: String(values.get("emergencyContact") || "").trim(),
        whatsappOptIn: values.has("whatsappOptIn"),
        notes: String(values.get("notes") || "").trim(),
        followUpStatus: current?.followUpStatus || "pending"
    };

    // The server answers with the whole member (fees, payments, plan), stored as it is.
    const saved = current
        ? await updateMemberOnApi(current.id, record)
        : await createMemberOnApi(record);
    if (!saved?.id) throw new Error("The member was not returned by the backend.");
    let createdAssignment = null;
    if (isNewMember && !current) updateMemberCount();
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

    if (createdAssignment) {
        setMemberCurrentMembership(saved.id, createdAssignment);
        // Shown at once; refreshTotals below reads the server's figure.
        const stored = getMember(saved.id);
        if (stored) stored.totalFees = Number(createdAssignment.total_fees ?? totalFees);
    }

    // Consent changes go through their own endpoint so the database records them in the history.
    await recordFormConsent(saved.id, record.whatsappOptIn);
    if (isNewMember) await saveFormPhoto(form, saved.id);

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

    if (isNewMember) refreshTotals(saved.id);
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
    const method = String(values.get("method"));
    const upiReference = method === "upi" ? String(values.get("upiReference") || "").replace(/\s/g, "") : "";
    if (upiReference && !UTR_PATTERN.test(upiReference)) throw new Error("The UPI reference (UTR) must be 12 digits.");
    if (form.dataset.saving === "true") return;
    const submit = document.querySelector('[type="submit"][form="payment-form"]');
    form.dataset.saving = "true";
    if (submit) submit.disabled = true;
    let saved;
    try {
        saved = await createPayment({
            member_id: member.id,
            membership_id: form.dataset.membershipId || null,
            amount,
            method,
            paid_on: String(values.get("date")),
            note: String(values.get("notes") || "").trim() || null,
            upi_reference: upiReference || null
        });
    } finally {
        form.dataset.saving = "false";
        if (submit?.isConnected) submit.disabled = false;
    }
    if (!saved) throw new Error("The payments API did not return the saved record.");
    const mapped = mapPayment(saved);
    if (member.memberCode) addPaidAmount(member.id, mapped.amount);
    state.apiMemberPayments[member.id] = [mapped, ...(state.apiMemberPayments[member.id] || []).filter((item) => item.id !== mapped.id)];
    safePersist(null);
    loadPaymentsPage(() => { if (["payments", "overview"].includes(currentView)) render(); });
    refreshTotals(member.id);
    await openReceiptDialog(saved.id, { recorded: true });
}

// After an import: every member, plan, membership and payment it added is reloaded.
function afterMemberImport() {
    membersStatus = "loading";
    refreshMembersFromApi().then(() => render());
    loadAllMemberships(() => render());
    refreshTotals();
    loadExpiringMemberships();
    loadPaymentsPage(() => { if (["payments", "overview"].includes(currentView)) render(); });
    if (currentView === "plans") loadPlans(renderPlansIfCurrent);
}

// A member's current membership status for exports, from the database.
function exportStatus(member) {
    if (member.status === "suspended") return "suspended";
    return getCurrentMembership(member.id)?.effective_status || "unassigned";
}

function memberExportRow(member) {
    const membership = getCurrentMembership(member.id);
    return {
        memberCode: member.memberCode || member.id,
        name: member.name,
        phone: member.phone,
        email: member.email || "",
        joinedAt: member.joinedAt,
        plan: planNameFor(member),
        startDate: membership?.start_date || member.startDate || "",
        expiryDate: membership?.end_date || member.expiryDate || ""
    };
}

function exportMembers() {
    runExport("members.csv", state.members.map((member) => ({
        ...memberExportRow(member),
        status: exportStatus(member),
        totalFees: member.totalFees,
        amountPaid: Math.max(0, Number(member.totalFees || 0) - memberBalance(member)),
        outstanding: memberBalance(member)
    })));
}

// Every payment of the gym from the database, newest first, 100 per request.
async function fetchAllPayments() {
    const payments = [];
    for (let page = 1; ; page += 1) {
        const response = await apiClient.get("/api/payments", { params: { page, limit: 100 } });
        const rows = response?.data?.payments || [];
        payments.push(...rows);
        const total = Number(response?.data?.pagination?.total ?? payments.length);
        if (!rows.length || payments.length >= total) return payments;
    }
}

function paymentExportRow(payment) {
    return {
        receiptNumber: payment.receipt_number,
        date: payment.paid_on,
        memberName: payment.member?.full_name || "Removed member",
        memberCode: payment.member?.member_code || "",
        amount: Number(payment.amount),
        method: methodLabel(payment.method),
        upiReference: payment.upi_reference || "",
        note: payment.note || ""
    };
}

async function exportPayments() {
    try {
        runExport("payments.csv", (await fetchAllPayments()).map(paymentExportRow));
    } catch (error) {
        toast(error.message || "Payments could not be loaded for the export.", "error");
    }
}

// Renewals: every plan after a member's first one.
function renewalRows() {
    return renewalMemberships().map((membership) => {
        const member = getMember(membership.member_id);
        return {
            memberCode: member?.memberCode || "",
            memberName: member?.name || "Removed member",
            renewedOn: String(membership.created_at || "").slice(0, 10),
            plan: membership.plan_name,
            startDate: membership.start_date,
            endDate: membership.end_date,
            fee: Number(membership.total_fees ?? membership.price ?? 0)
        };
    });
}

function exportRenewals() {
    runExport("renewals.csv", renewalRows());
}

function exportRetention() {
    runExport("retention-followups.csv", retentionRows().map(({ member, lastVisit, days, reasons }) => ({
        memberCode: member.memberCode || member.id,
        name: member.name,
        phone: member.phone,
        lastVisit: lastVisit || "",
        daysInactive: days ?? "",
        expiryDate: getCurrentMembership(member.id)?.end_date || member.expiryDate || "",
        reasons: reasons.join("; "),
        followUpStatus: member.followUpStatus || "pending"
    })));
}

function exportAnalytics() {
    const summary = currentSummary().data;
    if (!summary) return toast("The gym's totals are still loading. Try again in a moment.", "error");
    runExport("analytics-summary.csv", [
        { metric: "Total members", value: summary.total_members },
        { metric: "Active members", value: summary.active_members },
        { metric: "New members this month", value: summary.new_members_this_month },
        { metric: "Renewals this month", value: summary.renewals_this_month },
        { metric: "Collected this month", value: summary.collected_this_month },
        { metric: "Collected all time", value: summary.collected_all_time },
        { metric: "Outstanding balance", value: summary.outstanding_total },
        { metric: "Members with a balance", value: summary.members_with_balance },
        { metric: "Inactive members (14 days)", value: summary.inactive_members },
        { metric: "Check-ins, last 60 days", value: state.attendance.length }
    ]);
}

function attendanceRow(record) {
    const member = getMember(record.memberId);
    return {
        date: visitDay(record),
        time: new Intl.DateTimeFormat("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(record.checkedInAt)),
        memberCode: member?.memberCode || record.memberCode || "",
        memberName: member?.name || record.memberName || "Removed member",
        phone: member?.phone || "",
        method: record.source,
        membershipStatus: record.status || ""
    };
}

// One day's check-ins: from the 60-day feed, or from the database for older days.
async function attendanceForDay(day) {
    const feedStart = addDays(indiaISODate(), -59);
    if (day >= feedStart) return state.attendance.filter((record) => visitDay(record) === day);
    const response = await apiClient.get("/api/attendance", { params: { date: day } });
    return (response?.data || []).map((row) => ({ memberId: row.member_id, memberName: row.member?.full_name, memberCode: row.member?.member_code, checkedInAt: row.checked_in_at, checkInDate: row.check_in_date, source: row.method, status: row.membership_status_at_check_in }));
}

async function downloadReport() {
    const type = document.querySelector("#report-type")?.value;
    const date = document.querySelector("#report-date")?.value || indiaISODate();
    const today = indiaISODate();
    const filename = `${type || "report"}.csv`;
    try {
        let rows = [];
        if (type === "attendance-daily") rows = (await attendanceForDay(date)).map(attendanceRow);
        else if (type === "attendance-monthly") rows = state.attendance.filter((record) => visitDay(record).slice(0, 7) === today.slice(0, 7)).map(attendanceRow);
        else if (type === "revenue") {
            rows = (await fetchAllPayments()).map(paymentExportRow);
        } else if (type === "outstanding") rows = state.members.filter((member) => memberBalance(member) > 0).map((member) => ({ memberCode: member.memberCode || member.id, name: member.name, phone: member.phone, totalFees: member.totalFees, outstanding: memberBalance(member) }));
        else if (type === "memberships") rows = state.members.map((member) => ({ ...memberExportRow(member), status: exportStatus(member) }));
        else if (type === "renewals") rows = renewalRows();
        else if (type === "inactive") rows = retentionRows().filter((row) => row.days === null || row.days >= 14).map(({ member, lastVisit }) => ({ ...memberExportRow(member), lastVisit: lastVisit || "No visit in 60 days" }));
        runExport(filename, rows);
    } catch (error) {
        toast(error.message || "The report could not be made.", "error");
    }
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

// Everything on the Settings form is saved for the gym in the database, for every device.
async function saveSettings(form) {
    const values = new FormData(form);
    const phone = String(values.get("phone") || "").trim();
    if (phone && (phoneDigits(phone).length < 10 || phoneDigits(phone).length > 15)) throw new Error("Enter a valid gym phone number.");
    const name = String(values.get("name") || "").trim();
    if (!name) throw new Error("Gym name is required.");
    const upiId = String(values.get("upiId") || "").trim();
    const upiProblem = upiIdProblem(upiId);
    if (upiProblem) throw new Error(upiProblem);
    const upiPayeeName = String(values.get("upiPayeeName") || "").trim();
    if (upiPayeeName.length > 100) throw new Error("The name shown to payers must be 100 characters or fewer.");
    const address = String(values.get("address") || "").trim();
    const language = String(values.get("language") || "en");
    if (!isSupportedLanguage(language)) throw new Error("Choose English, Hindi or Marathi.");
    const dateFormat = values.get("dateFormat") === "DD/MM/YYYY" ? "DD/MM/YYYY" : "DD MMM YYYY";
    const reminderDays = Number(values.get("expiryReminderDays") || 0);
    if (!Number.isInteger(reminderDays) || reminderDays < 0 || reminderDays > 90) throw new Error("The expiry reminder window must be a whole number from 0 to 90 days.");
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
        await saveGymSettingsOnApi({
            name,
            phone: phone || null,
            address: address || null,
            upi_id: upiId || null,
            upi_payee_name: upiPayeeName || null,
            language,
            date_format: dateFormat,
            expiry_reminder_days: reminderDays,
            payment_reminders: values.has("paymentReminders"),
            inactivity_reminders: values.has("inactivityReminders")
        });
    } finally {
        if (submit?.isConnected) submit.disabled = false;
    }
    safePersist("Settings saved for your gym.");
}

async function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (handleAuthPasswordSubmit(event) || handleTermsSubmit(event) || handleRenewSubmit(event)) return;
    if (form.id === "delete-gym-form") {
        event.preventDefault();
        await submitDeleteGym(form, activeSession, closeModal);
        return;
    }
    if (form.id === "change-password-form") {
        event.preventDefault();
        await submitChangePassword(form, (session) => { activeSession = { ...activeSession, ...session }; });
        return;
    }
    if (form.id === "login-form") {
        event.preventDefault();
        const errorElement = document.querySelector("#auth-error");
        const submit = form.querySelector('[type="submit"]');
        // One sign-in at a time: a second tap would only use up the sign-in limit.
        if (submit?.disabled) return;
        errorElement.hidden = true;
        if (submit) submit.disabled = true;
        try {
            const result = await apiClient.post("/api/auth/login", {
                email: form.elements.email.value.trim(),
                password: form.elements.password.value,
                // Unticked (a shared computer): the session ends when the browser is closed.
                remember: form.elements.remember?.checked !== false
            });
            acceptSession(result.data);
        } catch (error) {
            errorElement.textContent = error.message || "Sign in failed.";
            errorElement.hidden = false;
        } finally {
            if (submit) submit.disabled = false;
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
    if (form.id === "attendance-settings-form") {
        event.preventDefault();
        await saveAttendanceSettings(form, rerenderForCheckinMethod);
        return;
    }
    if (form.id === "reminder-template-form") {
        event.preventDefault();
        await handleReminderTemplateSubmit(form);
        return;
    }
    const handlers = {
        "member-form": saveMember,
        "quick-member-form": saveQuickMember,
        "payment-form": savePayment,
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
        recordReminderClick(reminderLink);
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
        if (handleUpiPaymentAction(action.dataset.action, action)) return;
        // "Add photo" on a check-in card pauses the card and the scanner camera first.
        if (handlePhotoAction(action.dataset.action, action, rerenderAfterPhoto, {
            beforeAdd: (element) => (element.dataset.context === "checkin" ? pauseCheckinForPhoto() : () => {})
        })) return;
        if (handleAttendanceAction(action.dataset.action, action, rerenderAttendanceViews)) return;
        if (handleCheckinSettingsAction(action.dataset.action, action, rerenderForCheckinMethod)) return;
        if (action.dataset.action === "open-upi-settings") {
            closeModal();
            navigate("settings");
            return;
        }
        if (action.dataset.action === "retry-payments") {
            loadPaymentsPage(() => { if (currentView === "payments") render(); });
            return;
        }
        if (action.dataset.action.startsWith("welcome-")) {
            handleWelcomeAction(action.dataset.action, action, rerenderAfterWelcome);
            return;
        }
        if (handleReminderTemplateAction(action.dataset.action, () => { if (currentView === "settings") render(); })) return;
        if (handleLocalDataAction(action.dataset.action, afterLocalDataMove)) return;
        if (handleImportAction(action.dataset.action, action, afterMemberImport)) return;
        if (action.dataset.action === "previous-members-page" || action.dataset.action === "next-members-page") {
            const pageDelta = action.dataset.action === "next-members-page" ? 1 : -1;
            const pages = Math.max(1, Math.ceil(filterMembers(memberFilters).length / MEMBERS_PAGE_SIZE));
            memberFilters.page = Math.min(pages, Math.max(1, memberFilters.page + pageDelta));
            renderMembersResults();
            document.querySelector("#members-results")?.scrollIntoView({ block: "start", behavior: "smooth" });
            return;
        }
        if (handleMembershipAction(action.dataset.action, action)) return;
        if (handlePlanAction(action.dataset.action, action, renderPlansIfCurrent)) return;
        handleAction(action.dataset.action, action);
    }
});

document.addEventListener("submit", handleSubmit);
/**
 * Signs out everywhere it matters: the server revokes the session and clears the refresh and
 * "keep me signed in" cookies, then this page forgets its token and reloads to the sign-in screen.
 */
async function signOut() {
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
}
document.querySelector("#logout-button").addEventListener("click", signOut);
// Sign out from the screens before the app: new gym, Terms, and a gym scheduled for deletion.
for (const button of document.querySelectorAll("[data-sign-out]")) button.addEventListener("click", signOut);
document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.closest("#modal-root") && handleImportChange(target)) return;
    if (handleWelcomeTemplateEvent(target)) return;
    if (handleReminderTemplateEvent(target)) return;
    if (onPaymentFormEdit(target)) return;
    if (target.id === "visits-date" && target.value) { selectVisitsDay(target.value, () => { if (currentView === "attendance") render(); }); return; }
    if (target.closest("#modal-root")) updateMemberFormDefaults(target);
    if (target.id === "expiry-days") {
        expiringDays = Number(target.value);
        saveUiPreferences({ expiringDays });
        loadExpiringMemberships();
    }
    if (target.matches("#membership-assignment-form [name='plan_id'], #membership-assignment-form [name='start_date']")) updateAssignmentForm(target);
    if (target.id === "plan-status-filter") { setPlanStatus(target.value, renderPlansIfCurrent); return; }
    if (target.id === "form-duration_choice") { updatePlanDurationField(target); return; }
    if (target.id === "member-filter") {
        memberFilters.filter = target.value;
        memberFilters.page = 1;
        saveUiPreferences({ memberFilter: target.value });
        renderMembersResults();
    }
    if (target.id === "member-sort") {
        memberFilters.sort = target.value;
        memberFilters.page = 1;
        saveUiPreferences({ memberSort: target.value });
        renderMembersResults();
    }
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
    if (target.id === "reminder-body") { handleReminderTemplateEvent(target); return; }
    if (target.dataset.importNew !== undefined) { handleImportChange(target); return; }
    if (target.id === "checkin-search") { searchCheckInMembers(target.value); return; }
    if (target.form?.id === "payment-form" && ["amount", "upiReference"].includes(target.name)) { onPaymentFormEdit(target); return; }
    if (target.id === "setting-upiId" || target.id === "setting-upiPayeeName") { updateUpiTestQr(target.form); return; }
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
        renderMembersResults();
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

// Settings: redraw the ₹1 test QR as the UPI ID or payee name is typed.
function updateUpiTestQr(form) {
    const panel = form?.querySelector("#upi-test-qr");
    if (!panel) return;
    const upiId = String(form.elements.upiId.value || "").trim();
    const problem = upiIdProblem(upiId);
    const error = form.querySelector("#setting-upiId-error");
    if (error) {
        error.textContent = problem;
        error.hidden = !problem;
    }
    form.elements.upiId.setAttribute("aria-invalid", String(Boolean(problem)));
    panel.innerHTML = problem ? "" : renderUpiTestQr(upiId, String(form.elements.upiPayeeName.value || "").trim());
}

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
});
document.querySelector("#import-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) handleImportFile(file);
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

startErrorReporting({ view: () => currentView });
bindAuthPasswordLinks();
registerServiceWorker();
// The camera is released whenever the app is hidden, and comes back on the Check-in screen.
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        stopCheckInScreen();
        return;
    }
    // Phones pause timers in the background: refresh a token that ran out while the app was away.
    if (activeSession) ensureFreshSession().catch(() => {});
    if (currentView === "scan") startCheckInScreen(rerenderCheckIn);
});
setUnauthorizedHandler(() => {
    clearAuthSession();
    activeSession = null;
    saveAuthNotice("Your session expired. Please sign in again.");
    window.location.reload();
});
// "Connecting…" on the sign-in card while the server wakes up or the connection comes back.
function showConnecting(attempt) {
    showAuthScreen(false);
    document.querySelector("#login-form").hidden = true;
    document.querySelector("#connecting-panel").hidden = false;
    document.querySelector("#auth-title").textContent = "Connecting…";
    document.querySelector("#auth-description").textContent = "";
    document.querySelector("#auth-description").hidden = true;
    document.querySelector("#connecting-note").textContent = attempt >= 2
        ? "The server is taking a moment to wake up, or your connection is down. Trying again…"
        : "Restoring your session.";
}

async function restoreSessionOnLoad() {
    // A reset link from the email opens the new-password form, not a saved session.
    if (startPasswordResetIfLinked()) return;
    // "Connecting…" from the start, so a slow (cold) server never leaves the sign-in form
    // showing to someone who is in fact still signed in.
    showConnecting(0);
    try {
        // Keeps trying through a sleeping server or no network; only a rejected session gives up.
        const session = await restoreAuthSessionWithRetry({ onWaiting: showConnecting });
        if (session) acceptSession(session);
        else showAuthScreen(false, takeAuthNotice());
    } catch (error) {
        showAuthScreen(false, error.message || "Your saved session could not be restored.");
    }
}

restoreSessionOnLoad();
