// The expiry reminder message used by "Expiring soon", saved per gym and language in the
// database (migration 015), and the log of reminders sent. Edited in Settings.
import { apiClient } from "../api/apiClient.js";
import { toast } from "../components/toast.js";
import { getLanguage } from "../i18n.js";
import { escapeHTML } from "../utils.js";
import {
    DEFAULT_REMINDER_TEMPLATES,
    REMINDER_LANGUAGES,
    REMINDER_PLACEHOLDERS,
    REMINDER_TEMPLATE_MAX_LENGTH,
    reminderLanguage,
    reminderTemplateProblem
} from "../reminderMessage.js";

const LANGUAGE_NAMES = { en: "English", hi: "Hindi", mr: "Marathi" };

// { status: "idle" | "loading" | "ready" | "error", saved: { en?: body, hi?: body, mr?: body }, message }
export const reminderTemplates = { status: "idle", saved: {}, message: "" };
let request;

export function loadReminderTemplates({ force = false } = {}) {
    if (request) return request;
    if (reminderTemplates.status === "ready" && !force) return Promise.resolve(reminderTemplates);
    reminderTemplates.status = "loading";
    request = apiClient.get("/api/message-templates/expiry_reminder")
        .then((response) => {
            const rows = Array.isArray(response?.data) ? response.data : [];
            reminderTemplates.saved = Object.fromEntries(rows.filter((row) => REMINDER_LANGUAGES.includes(row.language)).map((row) => [row.language, row.body]));
            reminderTemplates.status = "ready";
            reminderTemplates.message = "";
            return reminderTemplates;
        })
        .catch((error) => {
            reminderTemplates.status = "error";
            reminderTemplates.message = error.message || "The reminder message could not be loaded.";
            return reminderTemplates;
        })
        .finally(() => { request = undefined; });
    return request;
}

/** The message to send, in the gym's language: the saved one, or the default. */
export function expiryReminderTemplate(language = getLanguage()) {
    const lang = reminderLanguage(language);
    return reminderTemplates.saved[lang] || DEFAULT_REMINDER_TEMPLATES[lang];
}

/** Logs that a reminder was opened in WhatsApp for this membership's current end date. */
export async function recordExpiryReminder({ memberId, membershipId, body, language = getLanguage() }) {
    const response = await apiClient.post(`/api/members/${memberId}/whatsapp-messages`, {
        reminder_type: "expiry",
        membership_id: membershipId,
        language: reminderLanguage(language),
        body: String(body || "").slice(0, 4096)
    });
    return response?.data || null;
}

// ---------- Settings ----------

const drafts = {};

function editorLanguage() {
    return reminderLanguage(document.querySelector("#reminder-language")?.value || getLanguage());
}

export function renderReminderTemplateSettings() {
    const heading = `<h2>WhatsApp expiry reminder</h2><p class="helper-text">Opened in WhatsApp from Expiring soon, only for members who agreed to WhatsApp updates. Saved for your gym, so every device uses the same message.</p>`;
    if (reminderTemplates.status === "idle" || reminderTemplates.status === "loading") {
        return `<section class="card settings-section" id="reminder-template-settings">${heading}<div class="empty-state" role="status">Loading reminder message…</div></section>`;
    }
    const error = reminderTemplates.status === "error"
        ? `<div class="note-box" role="alert">${escapeHTML(reminderTemplates.message)} <button class="text-button" type="button" data-action="reminder-retry-templates">Try again</button></div>`
        : "";
    const language = reminderLanguage(getLanguage());
    const body = drafts[language] ?? expiryReminderTemplate(language);
    return `<section class="card settings-section" id="reminder-template-settings">${heading}${error}
        <form id="reminder-template-form" class="form-grid" novalidate>
            <div class="field"><label for="reminder-language">Edit the message in</label><select id="reminder-language" name="language">${REMINDER_LANGUAGES.map((item) => `<option value="${item}" ${item === language ? "selected" : ""}>${LANGUAGE_NAMES[item]}</option>`).join("")}</select><span class="helper-text">Reminders are sent in your gym's language: <strong>${escapeHTML(LANGUAGE_NAMES[language])}</strong>.</span></div>
            <div class="field full"><label for="reminder-body">Message</label><textarea id="reminder-body" name="body" rows="4" maxlength="${REMINDER_TEMPLATE_MAX_LENGTH}" required>${escapeHTML(body)}</textarea>
                <span class="helper-text">Placeholders: ${REMINDER_PLACEHOLDERS.map((key) => `{${key}}`).join(", ")}</span>
                <span class="helper-text" id="reminder-default-note">${reminderTemplates.saved[language] ? "Using your saved message." : "Using the default message."}</span></div>
            <div class="field full welcome-template-actions"><button class="button button-primary" type="submit">Save reminder message</button><button class="button button-secondary" type="button" data-action="reminder-reset-template">Use default</button></div>
        </form></section>`;
}

function showLanguage(language) {
    const textarea = document.querySelector("#reminder-body");
    if (!textarea) return;
    textarea.value = drafts[language] ?? expiryReminderTemplate(language);
    const note = document.querySelector("#reminder-default-note");
    if (note) note.textContent = reminderTemplates.saved[language] ? "Using your saved message." : "Using the default message.";
}

/** Input and change events in the reminder editor. Returns true when handled. */
export function handleReminderTemplateEvent(target) {
    if (target.id === "reminder-body") { drafts[editorLanguage()] = target.value; return true; }
    if (target.id === "reminder-language") { showLanguage(reminderLanguage(target.value)); return true; }
    return false;
}

export async function handleReminderTemplateSubmit(form) {
    const language = reminderLanguage(form.elements.language.value);
    const body = form.elements.body.value;
    const problem = reminderTemplateProblem(body);
    if (problem) return toast(problem, "error");
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
        const response = await apiClient.put(`/api/message-templates/expiry_reminder/${language}`, { body });
        reminderTemplates.saved[language] = response?.data?.body ?? body.trim();
        delete drafts[language];
        showLanguage(language);
        toast(`Reminder message saved (${LANGUAGE_NAMES[language]}).`);
    } catch (error) {
        toast(error.message || "The reminder message could not be saved.", "error");
    } finally {
        if (submit?.isConnected) submit.disabled = false;
    }
}

/** Settings buttons for the reminder editor. Returns true when handled. */
export function handleReminderTemplateAction(action, onChange) {
    if (action === "reminder-retry-templates") {
        loadReminderTemplates({ force: true }).then(onChange);
        return true;
    }
    if (action === "reminder-reset-template") {
        const language = editorLanguage();
        (async () => {
            try {
                if (reminderTemplates.saved[language]) await apiClient.delete(`/api/message-templates/expiry_reminder/${language}`);
                delete reminderTemplates.saved[language];
                delete drafts[language];
                showLanguage(language);
                toast(`Default reminder message restored (${LANGUAGE_NAMES[language]}).`);
            } catch (error) {
                toast(error.message || "The default message could not be restored.", "error");
            }
        })();
        return true;
    }
    return false;
}
