// Welcome messages for new members, sent through wa.me (click-to-chat) and the phone's share
// sheet. Screens call only buildWelcomeMessage-backed helpers and sendWelcome, so switching to
// the WhatsApp Cloud API later means changing sendWelcome, not the screens.
// This file must not import modules that touch the DOM on load; the server tests import it.
import { state } from "../state.js";
import { apiClient } from "../api/apiClient.js";
import { getLanguage } from "../i18n.js";
import { formatDate } from "../utils.js";
import {
    DEFAULT_WELCOME_TEMPLATES,
    WELCOME_LANGUAGES,
    buildWelcomeMessage,
    welcomeLanguage,
    welcomePhone,
    welcomeWhatsAppUrl
} from "../welcomeMessage.js";

export { buildWelcomeMessage };

// ---------- Templates saved per gym in the database ----------

// { status: "idle" | "loading" | "ready" | "error", saved: { en?: body, hi?: body, mr?: body }, message }
export const welcomeTemplates = { status: "idle", saved: {}, message: "" };
let templateRequest;

export function loadWelcomeTemplates({ force = false } = {}) {
    if (templateRequest) return templateRequest;
    if (welcomeTemplates.status === "ready" && !force) return Promise.resolve(welcomeTemplates);
    welcomeTemplates.status = "loading";
    templateRequest = apiClient.get("/api/message-templates/welcome")
        .then((response) => {
            const rows = Array.isArray(response?.data) ? response.data : [];
            welcomeTemplates.saved = Object.fromEntries(rows.filter((row) => WELCOME_LANGUAGES.includes(row.language)).map((row) => [row.language, row.body]));
            welcomeTemplates.status = "ready";
            welcomeTemplates.message = "";
            return welcomeTemplates;
        })
        .catch((error) => {
            welcomeTemplates.status = "error";
            welcomeTemplates.message = error.message || "The welcome message could not be loaded.";
            return welcomeTemplates;
        })
        .finally(() => { templateRequest = undefined; });
    return templateRequest;
}

/** The language welcome messages are sent in: the language chosen in Settings. */
export function welcomeMessageLanguage() {
    try {
        return welcomeLanguage(getLanguage());
    } catch {
        return "en";
    }
}

export function welcomeTemplate(language = welcomeMessageLanguage()) {
    const lang = welcomeLanguage(language);
    return welcomeTemplates.saved[lang] || DEFAULT_WELCOME_TEMPLATES[lang];
}

export function isDefaultWelcomeTemplate(language) {
    return !welcomeTemplates.saved[welcomeLanguage(language)];
}

export async function saveWelcomeTemplate(language, body) {
    const lang = welcomeLanguage(language);
    const response = await apiClient.put(`/api/message-templates/welcome/${lang}`, { body });
    welcomeTemplates.saved[lang] = response?.data?.body ?? body.trim();
    return welcomeTemplates.saved[lang];
}

export async function resetWelcomeTemplate(language) {
    const lang = welcomeLanguage(language);
    await apiClient.delete(`/api/message-templates/welcome/${lang}`);
    delete welcomeTemplates.saved[lang];
}

// ---------- Values and the message ----------

function dateText(value) {
    return value ? formatDate(value) : "";
}

/** Placeholder values for one member. Missing values stay empty so their lines are left out. */
export function welcomeValues(member, { membership = member?.currentMembership, gym = state.gym } = {}) {
    return {
        name: member?.name || "",
        gym_name: gym?.name || "",
        plan: membership?.plan_name || "",
        start_date: dateText(membership?.start_date || member?.startDate),
        expiry_date: dateText(membership?.end_date || member?.expiryDate),
        member_code: member?.memberCode || "",
        gym_phone: gym?.phone || "",
        gym_address: gym?.address || ""
    };
}

/** "" when a welcome may be sent, otherwise why not: "no-consent" or "invalid-phone". */
export function welcomeBlocker(member) {
    if (member?.whatsappOptIn !== true) return "no-consent";
    return welcomePhone(member.phone) ? "" : "invalid-phone";
}

export function welcomeMessageFor(member, { membership, gym, language = welcomeMessageLanguage() } = {}) {
    return buildWelcomeMessage(welcomeTemplate(language), welcomeValues(member, { membership, gym }));
}

// ---------- Sending and the send log ----------

// Per member id: { status: "loading" | "ready" | "error", messages, message }.
export const welcomeLog = {};

export async function loadWelcomeLog(memberId, onChange = () => {}) {
    welcomeLog[memberId] = { status: "loading", messages: welcomeLog[memberId]?.messages || [] };
    onChange();
    try {
        const response = await apiClient.get(`/api/members/${memberId}/whatsapp-messages`, { params: { reminder_type: "welcome" } });
        welcomeLog[memberId] = { status: "ready", messages: Array.isArray(response?.data) ? response.data : [] };
    } catch (error) {
        welcomeLog[memberId] = { status: "error", messages: [], message: error.message || "Welcome history could not be loaded." };
    }
    onChange();
}

/** The most recent logged welcome for a member, or null. */
export function lastWelcome(memberId) {
    return welcomeLog[memberId]?.messages?.[0] || null;
}

async function recordWelcomeOnApi(memberId, payload) {
    const response = await apiClient.post(`/api/members/${memberId}/whatsapp-messages`, payload);
    const saved = response?.data;
    if (saved) {
        const log = welcomeLog[memberId] || { status: "ready", messages: [] };
        welcomeLog[memberId] = { ...log, status: log.status === "error" ? "ready" : log.status, messages: [saved, ...log.messages.filter((item) => item.id !== saved.id)] };
    }
    return saved;
}

function openInWhatsApp(url) {
    window.open(url, "_blank", "noopener");
}

/**
 * Sends the welcome message. Today this opens wa.me with the filled message; it must be called
 * directly from a click handler, before any await, or phones block the new window.
 * The returned promise settles when the send has been logged in whatsapp_messages.
 */
export function sendWelcome(member, { membership, gym, language = welcomeMessageLanguage(), open = openInWhatsApp, record = recordWelcomeOnApi } = {}) {
    const blocker = welcomeBlocker(member);
    if (blocker === "no-consent") throw new Error("This member has not agreed to receive WhatsApp updates.");
    if (blocker) throw new Error("This member does not have a valid Indian mobile number.");
    const message = welcomeMessageFor(member, { membership, gym, language });
    open(welcomeWhatsAppUrl(member.phone, message));
    return record(member.id, { reminder_type: "welcome", language: welcomeLanguage(language), body: message });
}

// ---------- The welcome card image ----------

export const CARD_SIZE = 1080;
const CARD_COLORS = { slate: "#1E2D3A", slate2: "#2A3F4F", marigold: "#F4A51C", white: "#FFFFFF", soft: "#C9D2D9" };
const HEADING_FONT = '"Anek Latin", "Anek Devanagari", sans-serif';
const BODY_FONT = '"Mukta", sans-serif';
const CARD_LABELS = {
    en: { welcome: "Welcome,", plan: "Plan", start: "Starts", expiry: "Valid until", code: "MEMBER ID" },
    hi: { welcome: "स्वागत है,", plan: "योजना", start: "शुरुआत", expiry: "वैध तिथि", code: "सदस्य आईडी" },
    mr: { welcome: "स्वागत आहे,", plan: "योजना", start: "सुरुवात", expiry: "वैध तारीख", code: "सदस्य आयडी" }
};

function setFont(context, weight, size, family) {
    context.font = `${weight} ${size}px ${family}`;
}

// Largest size between max and min at which the text fits, then trimmed with … if it still does not.
function fitText(context, text, { weight, family, max, min, width }) {
    let size = max;
    setFont(context, weight, size, family);
    while (size > min && context.measureText(text).width > width) {
        size -= 2;
        setFont(context, weight, size, family);
    }
    let fitted = text;
    while (fitted.length > 1 && context.measureText(fitted).width > width) fitted = `${fitted.slice(0, -2)}…`;
    return { text: fitted, size };
}

// The member name on one line if it fits large, otherwise on two balanced lines.
function nameLines(context, name, width) {
    const single = fitText(context, name, { weight: 800, family: HEADING_FONT, max: 104, min: 80, width });
    setFont(context, 800, single.size, HEADING_FONT);
    if (context.measureText(name).width <= width || !name.includes(" ")) return { lines: [single.text], size: single.size };
    const words = name.split(" ");
    let best = [name, ""];
    let bestWidth = Infinity;
    for (let index = 1; index < words.length; index += 1) {
        const pair = [words.slice(0, index).join(" "), words.slice(index).join(" ")];
        const widest = Math.max(...pair.map((line) => context.measureText(line).width));
        if (widest < bestWidth) { best = pair; bestWidth = widest; }
    }
    let size = 96;
    setFont(context, 800, size, HEADING_FONT);
    while (size > 56 && Math.max(...best.map((line) => context.measureText(line).width)) > width) {
        size -= 2;
        setFont(context, 800, size, HEADING_FONT);
    }
    return { lines: best.map((line) => fitText(context, line, { weight: 800, family: HEADING_FONT, max: size, min: size, width }).text), size };
}

function roundedRect(context, x, y, width, height, radius) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.arcTo(x + width, y, x + width, y + height, radius);
    context.arcTo(x + width, y + height, x, y + height, radius);
    context.arcTo(x, y + height, x, y, radius);
    context.arcTo(x, y, x + width, y, radius);
    context.closePath();
}

async function cardFontsReady(sample) {
    if (!document.fonts) return;
    const faces = ['700 52px "Anek Latin"', '800 104px "Anek Latin"', '700 44px "Anek Latin"', '700 52px "Anek Devanagari"', '800 104px "Anek Devanagari"', '700 44px "Anek Devanagari"', '500 44px "Mukta"', '400 34px "Mukta"'];
    // Fonts load per character range, so ask for the exact text the card will use.
    await Promise.all(faces.map((face) => document.fonts.load(face, sample).catch(() => [])));
    await document.fonts.ready;
}

/** Draws the 1080x1080 welcome card and resolves to a PNG file. The gym phone is not shown. */
export async function createWelcomeCard(member, { membership = member?.currentMembership, gym = state.gym, language = welcomeMessageLanguage() } = {}) {
    const labels = CARD_LABELS[welcomeLanguage(language)];
    const values = welcomeValues(member, { membership, gym });
    const rows = [[labels.plan, values.plan], [labels.start, values.start_date], [labels.expiry, values.expiry_date]].filter(([, value]) => value);
    await cardFontsReady([values.gym_name, values.name, values.member_code, ...Object.values(labels), ...rows.flat()].join(" "));

    const canvas = document.createElement("canvas");
    canvas.width = CARD_SIZE;
    canvas.height = CARD_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot draw the welcome card.");
    const pad = 96;
    const width = CARD_SIZE - pad * 2;
    context.textBaseline = "alphabetic";

    context.fillStyle = CARD_COLORS.slate;
    context.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
    context.fillStyle = CARD_COLORS.marigold;
    context.fillRect(0, 0, CARD_SIZE, 16);

    const gymName = fitText(context, values.gym_name || "GymPulse", { weight: 700, family: HEADING_FONT, max: 52, min: 34, width });
    context.fillStyle = CARD_COLORS.marigold;
    setFont(context, 700, gymName.size, HEADING_FONT);
    context.fillText(gymName.text, pad, 168);
    context.fillRect(pad, 200, 120, 8);

    context.fillStyle = CARD_COLORS.soft;
    setFont(context, 500, 44, BODY_FONT);
    context.fillText(labels.welcome, pad, 322);
    const name = nameLines(context, values.name, width);
    context.fillStyle = CARD_COLORS.white;
    setFont(context, 800, name.size, HEADING_FONT);
    name.lines.forEach((line, index) => context.fillText(line, pad, 430 + index * Math.round(name.size * 1.05)));

    const panelTop = 610;
    context.fillStyle = CARD_COLORS.slate2;
    roundedRect(context, pad - 32, panelTop, width + 64, 270, 24);
    context.fill();
    rows.forEach(([label, value], index) => {
        const y = panelTop + 72 + index * 82;
        context.fillStyle = CARD_COLORS.soft;
        setFont(context, 400, 34, BODY_FONT);
        context.textAlign = "left";
        context.fillText(label, pad, y);
        const labelWidth = context.measureText(label).width + 32;
        const fitted = fitText(context, value, { weight: 700, family: HEADING_FONT, max: 44, min: 30, width: width - labelWidth });
        context.fillStyle = CARD_COLORS.white;
        setFont(context, 700, fitted.size, HEADING_FONT);
        context.textAlign = "right";
        context.fillText(fitted.text, pad + width, y);
    });
    context.textAlign = "left";

    context.fillStyle = CARD_COLORS.marigold;
    context.fillRect(0, 940, CARD_SIZE, 140);
    context.fillStyle = CARD_COLORS.slate;
    setFont(context, 500, 32, BODY_FONT);
    context.fillText(labels.code, pad, 1024);
    if (values.member_code) {
        const code = fitText(context, values.member_code, { weight: 800, family: HEADING_FONT, max: 56, min: 32, width: width - context.measureText(labels.code).width - 32 });
        setFont(context, 800, code.size, HEADING_FONT);
        context.textAlign = "right";
        context.fillText(code.text, pad + width, 1030);
        context.textAlign = "left";
    }

    const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("The welcome card image could not be created.")), "image/png"));
    const fileName = `welcome-${String(values.member_code || "member").replace(/[^A-Za-z0-9-]/g, "")}.png`;
    return new File([blob], fileName, { type: "image/png" });
}

function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Shares the card through the phone's share sheet where files can be shared (Android Chrome),
 * otherwise downloads it. Resolves to "shared", "cancelled" or "downloaded".
 * Call it straight from the click with a ready file so the share keeps the user's tap.
 */
export async function shareWelcomeCard(file, { text = "" } = {}) {
    if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file], ...(text ? { text } : {}) });
            return "shared";
        } catch (error) {
            if (error?.name === "AbortError") return "cancelled";
            // NotAllowedError and similar: fall back to saving the file.
        }
    }
    downloadFile(file);
    return "downloaded";
}
