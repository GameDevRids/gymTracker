// The owner's account: forgot / reset password on the sign-in screen, change password and the
// full Excel download of the gym's data in Settings.
import { apiClient, setAuthSession } from "../api/apiClient.js";
import { PASSWORD_MIN_LENGTH, passwordProblem, readRecoveryLink } from "../passwordRules.js";
import { toast } from "../components/toast.js";
import { escapeHTML, downloadFile } from "../utils.js";
import { state } from "../state.js";

const RECOVERY_MESSAGES = {
    expired: "This reset link has expired or was already used. Ask for a new one below.",
    failed: "This reset link could not be used. Ask for a new one below.",
    missing: "Open the link from the reset email again, or ask for a new one below."
};

// The signed-in owner's email, for password managers on the change-password form.
let accountEmail = "";
export function setAccountEmail(email) {
    accountEmail = String(email || "");
}

// The reset link's one-hour token, kept only in memory and taken out of the address bar at once.
let recoveryToken = "";

function $(selector) {
    return document.querySelector(selector);
}

function setMessage(selector, message, kind = "error") {
    const element = $(selector);
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
    element.classList.toggle("auth-success", kind === "success");
}

// The sign-in screen's panels: [element, message element, element to focus].
const AUTH_PANELS = {
    login: ["#login-form", "#auth-error", "#login-email"],
    forgot: ["#forgot-password-form", "#forgot-error", "#forgot-email"],
    reset: ["#reset-password-form", "#reset-error", "#reset-password"],
    terms: ["#terms-form", "#terms-error", "#terms-form input[name=agree]"],
    deletion: ["#deletion-pending", "#deletion-error", "#cancel-deletion"]
};

/** Shows one of the sign-in screen's panels: "login", "forgot", "reset", "terms" or "deletion". */
export function showAuthForm(name, { message = "", kind = "error", title, description } = {}) {
    const titles = {
        login: ["Sign in to GymPulse", "Use your owner account to manage your gym."],
        forgot: ["Reset your password", "Enter your account's email. We'll send a link to choose a new password."],
        reset: ["Choose a new password", `Use at least ${PASSWORD_MIN_LENGTH} characters. Every device will be signed out.`],
        terms: ["Before you start", "GymPulse is in beta. Please agree to how it works and how it handles data."],
        deletion: ["Gym scheduled for deletion", ""]
    };
    $("#auth-screen").hidden = false;
    $("#app-shell").hidden = true;
    $(".mobile-bottom-nav").hidden = true;
    $("#create-gym-form").hidden = true;
    $("#connecting-panel").hidden = true;
    for (const [panel, [element, messageElement]] of Object.entries(AUTH_PANELS)) {
        $(element).hidden = panel !== name;
        setMessage(messageElement, "");
    }
    $("#auth-title").textContent = title ?? titles[name][0];
    $("#auth-description").textContent = description ?? titles[name][1];
    $("#auth-description").hidden = !$("#auth-description").textContent;
    if (message) setMessage(AUTH_PANELS[name][1], message, kind);
    $(AUTH_PANELS[name][2])?.focus();
}

/**
 * On /reset-password, reads the link from the email and shows the new-password form (or why the
 * link cannot be used). Returns true when this page load is a password reset.
 */
export function startPasswordResetIfLinked() {
    if (window.location.pathname !== "/reset-password") return false;
    const link = readRecoveryLink(window.location.hash, window.location.search);
    // The token must not stay in the address bar, the history or a screenshot.
    window.history.replaceState(null, "", "/reset-password");
    if (link.accessToken) {
        recoveryToken = link.accessToken;
        showAuthForm("reset");
    } else {
        showAuthForm("forgot", { message: RECOVERY_MESSAGES[link.error] || RECOVERY_MESSAGES.missing });
    }
    return true;
}

async function withSubmit(form, work) {
    const submit = form.querySelector('[type="submit"]');
    if (submit?.disabled) return;
    if (submit) submit.disabled = true;
    try {
        await work();
    } finally {
        if (submit) submit.disabled = false;
    }
}

async function submitForgotPassword(form) {
    setMessage("#forgot-error", "");
    await withSubmit(form, async () => {
        try {
            const result = await apiClient.post("/api/auth/forgot-password", { email: form.elements.email.value.trim() });
            setMessage("#forgot-error", result.message || "If an account uses that email, a reset link is on its way.", "success");
            form.reset();
        } catch (error) {
            setMessage("#forgot-error", error.message || "The reset email could not be sent. Please try again.");
        }
    });
}

async function submitResetPassword(form) {
    const password = form.elements.password.value;
    const confirmation = form.elements.confirm_password.value;
    const problem = passwordProblem(password, confirmation);
    if (problem) return setMessage("#reset-error", problem);
    if (!recoveryToken) return showAuthForm("forgot", { message: RECOVERY_MESSAGES.missing });
    setMessage("#reset-error", "");
    await withSubmit(form, async () => {
        try {
            const result = await apiClient.post("/api/auth/reset-password", {
                access_token: recoveryToken,
                password,
                confirm_password: confirmation
            });
            recoveryToken = "";
            form.reset();
            window.history.replaceState(null, "", "/");
            showAuthForm("login", { message: result.message || "Your password was changed. Sign in with the new password.", kind: "success" });
        } catch (error) {
            if (/expired|already used/i.test(error.message || "")) {
                recoveryToken = "";
                showAuthForm("forgot", { message: error.message });
            } else {
                setMessage("#reset-error", error.message || "The password could not be changed. Please try again.");
            }
        }
    });
}

/** Handles the sign-in screen's password forms. Returns true when the form was one of them. */
export function handleAuthPasswordSubmit(event) {
    const form = event.target;
    if (form.id === "forgot-password-form") {
        event.preventDefault();
        submitForgotPassword(form);
        return true;
    }
    if (form.id === "reset-password-form") {
        event.preventDefault();
        submitResetPassword(form);
        return true;
    }
    return false;
}

/** The sign-in screen's "Forgot password?" and "Back to sign in" buttons. */
export function bindAuthPasswordLinks() {
    $("#forgot-password-link")?.addEventListener("click", () => {
        const email = $("#login-email")?.value.trim() || "";
        showAuthForm("forgot");
        if (email) $("#forgot-email").value = email;
    });
    for (const button of document.querySelectorAll("[data-auth-back]")) {
        button.addEventListener("click", () => {
            recoveryToken = "";
            if (window.location.pathname === "/reset-password") window.history.replaceState(null, "", "/");
            showAuthForm("login");
        });
    }
}

function canDownloadWorkbook() {
    return state.gym.role === "owner";
}

/** Settings › Account and data: change password, and the owner's full data download. */
export function renderAccountSettings() {
    const download = canDownloadWorkbook()
        ? `<div class="account-download"><h3>Download all gym data</h3><p class="helper-text">One Excel file with every member, plan, payment and visit. Keep a copy somewhere safe; it has members' phone numbers.</p><button class="button button-secondary" type="button" data-action="download-workbook">↓ Download Excel file</button></div>`
        : "";
    return `<section class="card settings-section" id="account-settings"><h2>Account and data</h2>
        <form id="change-password-form" class="form-grid" novalidate>
            <input type="text" name="username" autocomplete="username" value="${escapeHTML(accountEmail)}" hidden>
            <div class="field full"><label for="current-password">Current password</label><input id="current-password" name="current_password" type="password" autocomplete="current-password" required></div>
            <div class="field"><label for="new-password">New password</label><input id="new-password" name="new_password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required aria-describedby="new-password-help"><span class="helper-text" id="new-password-help">At least ${PASSWORD_MIN_LENGTH} characters. Your other devices will be signed out.</span></div>
            <div class="field"><label for="confirm-new-password">New password again</label><input id="confirm-new-password" name="confirm_password" type="password" autocomplete="new-password" required></div>
            <p class="helper-text field-error full" id="change-password-error" role="alert" hidden></p>
            <div class="field full"><button class="button button-secondary" type="submit">Change password</button></div>
        </form>${download}<div class="account-signout"><h3>Sign out</h3><p class="helper-text">Ends your session on this device and tells the server to stop accepting it. Use it on a shared computer.</p><button class="button button-secondary" type="button" data-action="sign-out">Sign out</button></div></section>`;
}

/** Changes the password; this device keeps the fresh session the server sends back. */
export async function submitChangePassword(form, onSession = () => {}) {
    const values = {
        current_password: form.elements.current_password.value,
        new_password: form.elements.new_password.value,
        confirm_password: form.elements.confirm_password.value
    };
    const show = (message) => setMessage("#change-password-error", message);
    if (!values.current_password) return show("Enter your current password.");
    const problem = passwordProblem(values.new_password, values.confirm_password);
    if (problem) return show(problem);
    if (values.new_password === values.current_password) return show("Choose a password that is different from your current one.");
    show("");
    await withSubmit(form, async () => {
        try {
            const result = await apiClient.post("/api/auth/change-password", values);
            if (result?.data?.access_token) {
                setAuthSession(result.data);
                onSession(result.data);
            }
            form.reset();
            toast("Password changed. Your other devices were signed out.");
        } catch (error) {
            show(error.message || "The password could not be changed. Please try again.");
        }
    });
}

let downloading = false;

/** The owner's full copy of the gym's data as one .xlsx file, built by the server. */
export async function downloadGymWorkbook() {
    if (downloading || !canDownloadWorkbook()) return;
    downloading = true;
    toast("Preparing the Excel file…");
    try {
        const { blob, filename } = await apiClient.get("/api/export/workbook", { responseType: "blob", timeoutMs: 60000 });
        downloadFile(filename || "gympulse-data.xlsx", blob, blob.type);
    } catch (error) {
        toast(error.message || "The Excel file could not be downloaded. Please try again.", "error");
    } finally {
        downloading = false;
    }
}

// ---------- After sign-in: Terms, and a gym waiting to be deleted ----------

// From GET /api/account/status: Terms, deletion and the support WhatsApp number.
let accountStatus = null;
let continueToApp = () => {};

function formatWhen(value) {
    try {
        return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
    } catch {
        return String(value || "");
    }
}

/**
 * Runs between sign-in and the app: asks for the Terms once per version, and shows the
 * "scheduled for deletion" screen instead of the app when the gym is waiting to be erased.
 * If the status cannot be loaded (for example before migration 017), the app opens as before.
 */
export async function checkAccountBeforeApp(session, onReady) {
    continueToApp = () => {
        const deletion = accountStatus?.deletion || session.gym?.deletion;
        if (session.gym && deletion) showDeletionPending(session, deletion);
        else onReady();
    };
    try {
        accountStatus = (await apiClient.get("/api/account/status"))?.data || null;
    } catch (error) {
        console.error("GymPulse could not load the account status.", error);
        accountStatus = null;
    }
    if (accountStatus?.terms && !accountStatus.terms.accepted_at) {
        showAuthForm("terms");
        return;
    }
    continueToApp();
}

async function submitTerms(form) {
    if (!form.elements.agree.checked) return setMessage("#terms-error", "Tick the box to agree, or sign out.");
    await withSubmit(form, async () => {
        try {
            await apiClient.post("/api/account/terms", { version: accountStatus?.terms?.version });
            accountStatus.terms.accepted_at = new Date().toISOString();
            continueToApp();
        } catch (error) {
            setMessage("#terms-error", error.message || "Your agreement could not be saved. Please try again.");
        }
    });
}

/** Handles the Terms form. Returns true when the event was it. */
export function handleTermsSubmit(event) {
    if (event.target.id !== "terms-form") return false;
    event.preventDefault();
    submitTerms(event.target);
    return true;
}

function showDeletionPending(session, deletion) {
    const owner = (session.gym.role || "owner") === "owner";
    state.gym.role = session.gym.role || "owner";
    showAuthForm("deletion");
    $("#deletion-pending-text").textContent = owner
        ? `All of ${session.gym.name}'s data (members, payments, attendance and photos) will be erased on ${formatWhen(deletion.scheduled_for)}. Until then you can download it or cancel the deletion.`
        : `${session.gym.name} is scheduled for deletion on ${formatWhen(deletion.scheduled_for)}. Only the gym owner can cancel it.`;
    $("#deletion-owner-actions").hidden = !owner;
    const cancel = $("#cancel-deletion");
    cancel.onclick = async () => {
        if (cancel.disabled) return;
        cancel.disabled = true;
        try {
            await apiClient.post("/api/account/cancel-deletion", {});
            if (accountStatus) accountStatus.deletion = null;
            delete session.gym.deletion;
            continueToApp();
            toast("The deletion was cancelled. Your gym works as before.");
        } catch (error) {
            setMessage("#deletion-error", error.message || "The deletion could not be cancelled. Please try again.");
        } finally {
            cancel.disabled = false;
        }
    };
}

// ---------- Settings: delete the gym, and report a problem ----------

/** Settings › Delete gym account (owners only; not the demo gym). */
export function renderDeleteGymSettings() {
    if (state.gym.role !== "owner" || state.gym.isDemo) return "";
    return `<section class="card settings-section danger-zone"><h2>Delete gym account</h2>
        <p class="helper-text">Locks the gym at once for everyone. After 7 days, every member, payment, visit, photo and staff account is erased for good. You can cancel within those 7 days. Download your data first if you want to keep it.</p>
        <button class="button button-danger" type="button" data-action="delete-gym">Delete gym account…</button></section>`;
}

export function openDeleteGymDialog(openModal) {
    const name = state.gym.name || "";
    openModal({
        title: "Delete gym account",
        subtitle: "The gym is locked now and erased after 7 days.",
        body: `<form id="delete-gym-form" class="form-grid" novalidate>
            <p class="full">To confirm, type the gym's name <strong>${escapeHTML(name)}</strong> and your password.</p>
            <input type="text" name="username" autocomplete="username" value="${escapeHTML(accountEmail)}" hidden>
            <div class="field full"><label for="delete-gym-name">Gym name</label><input id="delete-gym-name" name="confirm_name" autocomplete="off" required></div>
            <div class="field full"><label for="delete-gym-password">Your password</label><input id="delete-gym-password" name="password" type="password" autocomplete="current-password" required></div>
            <p class="helper-text field-error full" id="delete-gym-error" role="alert" hidden></p>
            <div class="field full"><button class="button button-danger" type="submit">Delete gym account</button></div>
        </form>`
    });
}

/** Submits the delete dialog; on success the app switches to the "scheduled for deletion" screen. */
export async function submitDeleteGym(form, session, closeModal) {
    const confirmName = form.elements.confirm_name.value.trim();
    const password = form.elements.password.value;
    const show = (message) => setMessage("#delete-gym-error", message);
    if (confirmName.toLowerCase() !== String(state.gym.name || "").trim().toLowerCase()) return show("Type the gym's name exactly as shown.");
    if (!password) return show("Enter your password.");
    await withSubmit(form, async () => {
        try {
            const result = await apiClient.post("/api/account/delete-gym", { confirm_name: confirmName, password });
            closeModal();
            const deletion = result?.data?.deletion;
            if (accountStatus) accountStatus.deletion = deletion;
            session.gym.deletion = deletion;
            showDeletionPending(session, deletion);
        } catch (error) {
            show(error.message || "The gym could not be deleted. Please try again.");
        }
    });
}

/** The "Report a problem" link: a WhatsApp chat with support, with the app's details filled in. */
export function reportProblemUrl({ view = "", version = "" } = {}) {
    const number = accountStatus?.support_whatsapp;
    if (!number) return "";
    const device = /Android/.test(navigator.userAgent) ? "Android" : /iPhone|iPad/.test(navigator.userAgent) ? "iPhone/iPad" : "Computer";
    const text = [
        "GymPulse problem report",
        `Gym: ${state.gym.name || ""}`,
        `App version: ${version}`,
        `Screen: ${view}`,
        `Device: ${device}`,
        "",
        "What happened (please leave out members' phone numbers):",
        ""
    ].join("\n");
    return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

/** Settings › Help: "Report a problem" (only when SUPPORT_WHATSAPP_NUMBER is set) and the legal pages. */
export function renderSupportSettings(status = accountStatus) {
    const report = status?.support_whatsapp
        ? `<p class="helper-text">Something not working? Send us a WhatsApp message. The app version and screen are filled in for you.</p><button class="button button-secondary" type="button" data-action="report-problem">Report a problem</button>`
        : "";
    return `<section class="card settings-section"><h2>Help and legal</h2>${report}<p class="helper-text"><a href="/terms" target="_blank" rel="noopener">Terms of Service</a> · <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a></p></section>`;
}
