// The enquiry follow-up message (Enquiries > WhatsApp), saved per gym and language in the database
// like the welcome and expiry messages (migration 024). Edited in Settings > Messages.
import { apiClient } from "../api/apiClient.js";
import { toast } from "../components/toast.js";
import { getLanguage } from "../i18n.js";
import { escapeHTML } from "../utils.js";
import { DEFAULT_ENQUIRY_TEMPLATES, ENQUIRY_LANGUAGES, ENQUIRY_PLACEHOLDERS, ENQUIRY_TEMPLATE_MAX_LENGTH, enquiryLanguage, enquiryTemplateProblem } from "../enquiries.js";

const LANGUAGE_NAMES = { en: "English", hi: "Hindi", mr: "Marathi" };

// { status: "idle" | "loading" | "ready" | "error", saved: { en?: body, hi?: body, mr?: body }, message }
export const enquiryTemplates = { status: "idle", saved: {}, message: "" };
let request;

export function loadEnquiryTemplates({ force = false } = {}) {
    if (request) return request;
    if (enquiryTemplates.status === "ready" && !force) return Promise.resolve(enquiryTemplates);
    enquiryTemplates.status = "loading";
    request = apiClient.get("/api/message-templates/enquiry_followup")
        .then((response) => {
            const rows = Array.isArray(response?.data) ? response.data : [];
            enquiryTemplates.saved = Object.fromEntries(rows.filter((row) => ENQUIRY_LANGUAGES.includes(row.language)).map((row) => [row.language, row.body]));
            enquiryTemplates.status = "ready";
            enquiryTemplates.message = "";
            return enquiryTemplates;
        })
        .catch((error) => {
            enquiryTemplates.status = "error";
            enquiryTemplates.message = error.message || "The enquiry message could not be loaded.";
            return enquiryTemplates;
        })
        .finally(() => { request = undefined; });
    return request;
}

/** The message to send, in the gym's language: the saved one, or the default. */
export function enquiryTemplate(language = getLanguage()) {
    const lang = enquiryLanguage(language);
    return enquiryTemplates.saved[lang] || DEFAULT_ENQUIRY_TEMPLATES[lang];
}

// ---------- Settings > Messages ----------

const drafts = {};

function editorLanguage() {
    return enquiryLanguage(document.querySelector("#enquiry-template-language")?.value || getLanguage());
}

export function renderEnquiryTemplateSettings() {
    const heading = `<h2>WhatsApp enquiry follow-up</h2><p class="helper-text">Opened in WhatsApp from Enquiries, only for visitors who agreed to messages. Saved for your gym, so every device uses the same message.</p>`;
    if (enquiryTemplates.status === "idle" || enquiryTemplates.status === "loading") {
        return `<section class="card settings-section" id="enquiry-template-settings">${heading}<div class="empty-state" role="status">Loading enquiry message…</div></section>`;
    }
    const error = enquiryTemplates.status === "error"
        ? `<div class="note-box" role="alert">${escapeHTML(enquiryTemplates.message)} <button class="text-button" type="button" data-action="enquiry-template-retry">Try again</button></div>`
        : "";
    const language = enquiryLanguage(getLanguage());
    const body = drafts[language] ?? enquiryTemplate(language);
    return `<section class="card settings-section" id="enquiry-template-settings">${heading}${error}
        <form id="enquiry-template-form" class="form-grid" novalidate>
            <div class="field"><label for="enquiry-template-language">Edit the message in</label><select id="enquiry-template-language" name="language">${ENQUIRY_LANGUAGES.map((item) => `<option value="${item}" ${item === language ? "selected" : ""}>${LANGUAGE_NAMES[item]}</option>`).join("")}</select></div>
            <div class="field full"><label for="enquiry-template-body">Message</label><textarea id="enquiry-template-body" name="body" rows="4" maxlength="${ENQUIRY_TEMPLATE_MAX_LENGTH}" required>${escapeHTML(body)}</textarea>
                <span class="helper-text">Placeholders: ${ENQUIRY_PLACEHOLDERS.map((key) => `{${key}}`).join(", ")}</span>
                <span class="helper-text" id="enquiry-template-note">${enquiryTemplates.saved[language] ? "Using your saved message." : "Using the default message."}</span></div>
            <div class="field full welcome-template-actions"><button class="button button-secondary" type="submit">Save enquiry message</button><button class="button button-secondary" type="button" data-action="enquiry-template-reset">Use default</button></div>
        </form></section>`;
}

function showLanguage(language) {
    const textarea = document.querySelector("#enquiry-template-body");
    if (!textarea) return;
    textarea.value = drafts[language] ?? enquiryTemplate(language);
    const note = document.querySelector("#enquiry-template-note");
    if (note) note.textContent = enquiryTemplates.saved[language] ? "Using your saved message." : "Using the default message.";
}

/** Input and change events in the editor. Returns true when handled. */
export function handleEnquiryTemplateEvent(target) {
    if (target.id === "enquiry-template-body") { drafts[editorLanguage()] = target.value; return true; }
    if (target.id === "enquiry-template-language") { showLanguage(enquiryLanguage(target.value)); return true; }
    return false;
}

export async function handleEnquiryTemplateSubmit(form) {
    const language = enquiryLanguage(form.elements.language.value);
    const body = form.elements.body.value;
    const problem = enquiryTemplateProblem(body);
    if (problem) return toast(problem, "error");
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
        const response = await apiClient.put(`/api/message-templates/enquiry_followup/${language}`, { body });
        enquiryTemplates.saved[language] = response?.data?.body ?? body.trim();
        delete drafts[language];
        showLanguage(language);
        toast(`Enquiry message saved (${LANGUAGE_NAMES[language]}).`);
    } catch (error) {
        toast(error.message || "The enquiry message could not be saved.", "error");
    } finally {
        if (submit?.isConnected) submit.disabled = false;
    }
}

/** Settings buttons for the editor. Returns true when handled. */
export function handleEnquiryTemplateAction(action, onChange) {
    if (action === "enquiry-template-retry") {
        loadEnquiryTemplates({ force: true }).then(onChange);
        return true;
    }
    if (action === "enquiry-template-reset") {
        const language = editorLanguage();
        (async () => {
            try {
                if (enquiryTemplates.saved[language]) await apiClient.delete(`/api/message-templates/enquiry_followup/${language}`);
                delete enquiryTemplates.saved[language];
                delete drafts[language];
                showLanguage(language);
                toast(`Default enquiry message restored (${LANGUAGE_NAMES[language]}).`);
            } catch (error) {
                toast(error.message || "The default message could not be restored.", "error");
            }
        })();
        return true;
    }
    return false;
}
