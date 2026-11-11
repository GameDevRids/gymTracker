// Screens for the welcome message: the "Member added" dialog, the member profile section and
// the template editor in Settings. Sending goes only through sendWelcome in welcome.js.
import { state, getMember } from "../state.js";
import { openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { escapeHTML, localISODate, addDays } from "../utils.js";
import { getLanguage } from "../i18n.js";
import { getCurrentMembership } from "./memberMemberships.js";
import {
    createWelcomeCard,
    isDefaultWelcomeTemplate,
    lastWelcome,
    loadWelcomeLog,
    loadWelcomeTemplates,
    resetWelcomeTemplate,
    saveWelcomeTemplate,
    sendWelcome,
    shareWelcomeCard,
    welcomeBlocker,
    welcomeLog,
    welcomeMessageFor,
    welcomeTemplate,
    welcomeTemplates,
    welcomeValues
} from "./welcome.js";
import { WELCOME_LANGUAGES, WELCOME_PLACEHOLDERS, buildWelcomeMessage, welcomeLanguage, welcomeTemplateProblem } from "../welcomeMessage.js";

const LANGUAGE_NAMES = { en: "English", hi: "Hindi · हिन्दी", mr: "Marathi · मराठी" };

function sentDate(value) {
    return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(value)) : "";
}

// ---------- Welcome card, prepared ahead so sharing can happen inside the tap ----------

const preparedCards = new Map();

function cardKey(member, membership) {
    return [member.id, member.name, member.memberCode, membership?.plan_name, membership?.start_date, membership?.end_date, state.gym.name, getLanguage()].join("|");
}

function prepareCard(member) {
    const membership = getCurrentMembership(member.id);
    const key = cardKey(member, membership);
    const existing = preparedCards.get(member.id);
    if (existing?.key === key) return existing;
    const entry = { key, file: null, promise: null };
    entry.promise = createWelcomeCard(member, { membership }).then((file) => { entry.file = file; return file; });
    entry.promise.catch(() => preparedCards.delete(member.id));
    preparedCards.set(member.id, entry);
    return entry;
}

function reportShare(result) {
    if (result === "downloaded") toast("Card saved. Attach it in WhatsApp.");
    else if (result === "shared") toast("Welcome card shared.");
}

// ---------- Actions (all synchronous up to the WhatsApp or share call) ----------

function sendFromClick(member, button, onLogged) {
    let pending;
    try {
        pending = sendWelcome(member, { membership: getCurrentMembership(member.id) });
    } catch (error) {
        toast(error.message, "error");
        return;
    }
    if (button) button.disabled = true;
    pending
        .then(() => {
            toast("WhatsApp opened with the welcome message. Recorded as sent.");
            onLogged?.();
        })
        .catch((error) => toast(`WhatsApp opened, but the send could not be recorded: ${error.message || "please try again."}`, "error"))
        .finally(() => { if (button?.isConnected) button.disabled = false; });
}

function shareFromClick(member, button) {
    if (welcomeBlocker(member) === "no-consent") return toast("This member has not agreed to receive WhatsApp updates.", "error");
    const entry = prepareCard(member);
    const text = welcomeMessageFor(member, { membership: getCurrentMembership(member.id) });
    if (button) button.disabled = true;
    // With the file ready, navigator.share runs in this same tap.
    const sharing = entry.file ? shareWelcomeCard(entry.file, { text }) : entry.promise.then((file) => shareWelcomeCard(file, { text }));
    sharing
        .then(reportShare)
        .catch((error) => toast(error.message || "The welcome card could not be created.", "error"))
        .finally(() => { if (button?.isConnected) button.disabled = false; });
}

/** Handles data-action="welcome-*" clicks. Returns true when the action was handled. */
export function handleWelcomeAction(action, element, rerender) {
    if (action === "welcome-insert") {
        insertPlaceholder(element.dataset.key);
        return true;
    }
    if (action === "welcome-reset-template") {
        resetTemplate();
        return true;
    }
    if (action === "welcome-retry-templates") {
        loadWelcomeTemplates({ force: true }).then(rerender);
        rerender();
        return true;
    }
    const member = getMember(element.dataset.id);
    if (!member) {
        if (action.startsWith("welcome-")) toast("Member was not found.", "error");
        return action.startsWith("welcome-");
    }
    if (action === "welcome-send") {
        sendFromClick(member, element, () => {
            if (element.closest(".welcome-footer")) markDialogSent(element);
            rerender();
        });
        return true;
    }
    if (action === "welcome-share-card") {
        shareFromClick(member, element);
        return true;
    }
    if (action === "welcome-retry-log") {
        loadWelcomeLog(member.id, rerender);
        return true;
    }
    return false;
}

// ---------- "Member added" dialog ----------

function markDialogSent(button) {
    if (!button.isConnected) return;
    button.textContent = "Welcome sent ✓ · Send again";
    const skip = document.querySelector("#member-added-skip");
    if (skip) skip.textContent = "Done";
}

/** Shows the confirmation after a member is saved. Welcome actions only appear with consent. */
export async function openMemberAddedDialog(member) {
    if (!member || welcomeBlocker(member)) return false;
    if (welcomeTemplates.status !== "ready") await loadWelcomeTemplates();
    const membership = getCurrentMembership(member.id);
    const message = welcomeMessageFor(member, { membership });
    prepareCard(member);
    const fallbackNote = welcomeTemplates.status === "error"
        ? `<p class="helper-text" role="status">Your saved welcome message could not be loaded, so the default is shown.</p>`
        : "";
    openModal({
        title: "Member added",
        subtitle: `${escapeHTML(member.name)} is saved and their plan is assigned.`,
        body: `<div id="member-added" class="welcome-dialog">
            <p class="welcome-dialog-label">Welcome message</p>
            <div class="welcome-preview">${escapeHTML(message)}</div>
            ${fallbackNote}
            <p class="helper-text">WhatsApp opens with this message filled in. You press send in WhatsApp.</p>
        </div>`,
        footer: `<div class="welcome-footer">
            <button class="button button-secondary" type="button" id="member-added-skip" data-action="close-modal">Skip</button>
            <button class="button button-secondary" type="button" data-action="welcome-share-card" data-id="${escapeHTML(member.id)}">Share welcome card</button>
            <button class="button button-whatsapp" type="button" data-action="welcome-send" data-id="${escapeHTML(member.id)}">Send welcome on WhatsApp</button>
        </div>`
    });
    return true;
}

// ---------- Member profile ----------

export function renderWelcomeSection(member) {
    const blocker = welcomeBlocker(member);
    let content;
    if (blocker === "no-consent") {
        content = `<p class="helper-text">Record WhatsApp consent before sending a welcome message.</p>`;
    } else if (blocker) {
        content = `<p class="helper-text">Add a valid Indian mobile number to send a welcome message.</p>`;
    } else {
        const log = welcomeLog[member.id];
        const last = lastWelcome(member.id);
        const share = `<button class="button button-secondary" type="button" data-action="welcome-share-card" data-id="${escapeHTML(member.id)}">Share welcome card</button>`;
        if (!log || log.status === "loading") {
            content = `<div class="empty-state" role="status">Checking welcome history…</div>`;
        } else if (log.status === "error") {
            content = `<div class="empty-state" role="alert"><p>${escapeHTML(log.message)}</p><button class="button button-secondary" data-action="welcome-retry-log" data-id="${escapeHTML(member.id)}">Try again</button></div>`;
        } else if (last) {
            content = `<p class="welcome-status"><span class="status status-active">Welcome sent</span> on ${escapeHTML(sentDate(last.created_at))}</p><div class="welcome-profile-actions"><button class="button button-secondary" type="button" data-action="welcome-send" data-id="${escapeHTML(member.id)}">Send again</button>${share}</div>`;
        } else {
            content = `<p class="helper-text">No welcome message sent yet.</p><div class="welcome-profile-actions"><button class="button button-whatsapp" type="button" data-action="welcome-send" data-id="${escapeHTML(member.id)}">Send welcome</button>${share}</div>`;
        }
    }
    return `<section class="card profile-section" id="member-welcome"><div class="card-header"><div><h2>WhatsApp welcome</h2></div></div><div class="card-body">${content}</div></section>`;
}

// ---------- Settings: template editor with live preview ----------

// Unsaved edits per language, so switching language in the editor does not lose them.
const drafts = {};

function previewValues() {
    const start = localISODate();
    return {
        membership: { plan_name: "Monthly", start_date: start, end_date: addDays(start, 30) },
        member: { name: "Riya Shah", memberCode: "GP-7F3A2C91B4D0" }
    };
}

// The preview fills the template exactly as a real send would, with a sample member and this gym.
function previewText(body) {
    const problem = welcomeTemplateProblem(body);
    if (problem) return { text: problem, problem: true };
    const sample = previewValues();
    return { text: buildWelcomeMessage(body, welcomeValues(sample.member, { membership: sample.membership })), problem: false };
}

function editorLanguage() {
    const select = document.querySelector("#welcome-language");
    return welcomeLanguage(select?.value || getLanguage());
}

export function renderWelcomeTemplateSettings() {
    const sendLanguage = welcomeLanguage(getLanguage());
    const heading = `<h2>WhatsApp welcome message</h2><p class="helper-text">Offered after you add a member who agreed to WhatsApp updates, and on their profile. Saved for your gym, so every device uses the same message.</p>`;
    if (welcomeTemplates.status === "idle" || welcomeTemplates.status === "loading") {
        return `<section class="card settings-section" id="welcome-template-settings">${heading}<div class="empty-state" role="status">Loading welcome message…</div></section>`;
    }
    const error = welcomeTemplates.status === "error"
        ? `<div class="note-box" role="alert">${escapeHTML(welcomeTemplates.message)} <button class="text-button" type="button" data-action="welcome-retry-templates">Try again</button></div>`
        : "";
    const body = drafts[sendLanguage] ?? welcomeTemplate(sendLanguage);
    const preview = previewText(body);
    return `<section class="card settings-section" id="welcome-template-settings">${heading}${error}
        <form id="welcome-template-form" class="form-grid" novalidate>
            <div class="field"><label for="welcome-language">Edit the message in</label><select id="welcome-language" name="language">${WELCOME_LANGUAGES.map((language) => `<option value="${language}" ${language === sendLanguage ? "selected" : ""}>${LANGUAGE_NAMES[language]}</option>`).join("")}</select><span class="helper-text">Messages are sent in the Language chosen above: <strong>${escapeHTML(LANGUAGE_NAMES[sendLanguage])}</strong>.</span></div>
            <div class="field full"><label for="welcome-body">Message</label><textarea id="welcome-body" name="body" rows="7" maxlength="1000" required>${escapeHTML(body)}</textarea>
                <div class="welcome-placeholders" aria-label="Insert a placeholder">${WELCOME_PLACEHOLDERS.map((key) => `<button class="badge-soft welcome-chip" type="button" data-action="welcome-insert" data-key="${key}">{${key}}</button>`).join("")}</div>
                <span class="helper-text">A line is left out when its placeholder has no value, for example when the gym phone is not set.</span></div>
            <div class="field full"><span class="field-label" id="welcome-preview-label">Preview</span><div class="welcome-preview ${preview.problem ? "welcome-preview-problem" : ""}" id="welcome-preview" aria-labelledby="welcome-preview-label" aria-live="polite">${escapeHTML(preview.text)}</div><span class="helper-text" id="welcome-default-note">${isDefaultWelcomeTemplate(sendLanguage) ? "Using the default message." : "Using your saved message."}</span></div>
            <div class="field full welcome-template-actions"><button class="button button-primary" type="submit">Save welcome message</button><button class="button button-secondary" type="button" data-action="welcome-reset-template">Use default</button></div>
        </form></section>`;
}

function updatePreview() {
    const textarea = document.querySelector("#welcome-body");
    const preview = document.querySelector("#welcome-preview");
    if (!textarea || !preview) return;
    drafts[editorLanguage()] = textarea.value;
    const result = previewText(textarea.value);
    preview.textContent = result.text;
    preview.classList.toggle("welcome-preview-problem", result.problem);
}

function showLanguage(language) {
    const textarea = document.querySelector("#welcome-body");
    if (!textarea) return;
    textarea.value = drafts[language] ?? welcomeTemplate(language);
    const note = document.querySelector("#welcome-default-note");
    if (note) note.textContent = isDefaultWelcomeTemplate(language) ? "Using the default message." : "Using your saved message.";
    updatePreview();
}

function insertPlaceholder(key) {
    const textarea = document.querySelector("#welcome-body");
    if (!textarea || !WELCOME_PLACEHOLDERS.includes(key)) return;
    const token = `{${key}}`;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.setRangeText(token, start, end, "end");
    textarea.focus();
    updatePreview();
}

/** Input and change events inside the editor. Returns true when handled. */
export function handleWelcomeTemplateEvent(target) {
    if (target.id === "welcome-body") { updatePreview(); return true; }
    if (target.id === "welcome-language") { showLanguage(welcomeLanguage(target.value)); return true; }
    return false;
}

export async function handleWelcomeTemplateSubmit(form) {
    const language = welcomeLanguage(form.elements.language.value);
    const body = form.elements.body.value;
    const problem = welcomeTemplateProblem(body);
    if (problem) return toast(problem, "error");
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
        await saveWelcomeTemplate(language, body);
        delete drafts[language];
        showLanguage(language);
        toast(`Welcome message saved (${LANGUAGE_NAMES[language]}).`);
    } catch (error) {
        toast(error.message || "The welcome message could not be saved.", "error");
    } finally {
        if (submit?.isConnected) submit.disabled = false;
    }
}

async function resetTemplate() {
    const language = editorLanguage();
    try {
        if (!isDefaultWelcomeTemplate(language)) await resetWelcomeTemplate(language);
        delete drafts[language];
        showLanguage(language);
        delete drafts[language];
        toast(`Default welcome message restored (${LANGUAGE_NAMES[language]}).`);
    } catch (error) {
        toast(error.message || "The default message could not be restored.", "error");
    }
}
