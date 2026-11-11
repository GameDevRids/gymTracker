// Welcome messages for new members, sent through wa.me (click-to-chat) and the phone's share
// sheet. Screens call only buildWelcomeMessage-backed helpers and sendWelcome, so switching to
// the WhatsApp Cloud API later means changing sendWelcome, not the screens.
// This file must not import modules that touch the DOM on load; the server tests import it.
import { state } from "../state.js";
import { apiClient } from "../api/apiClient.js";
import { getLanguage } from "../i18n.js";
import { formatDate, formatINR } from "../utils.js";
import { CARD_COLORS, cardFontFamilies, cardFontsReady, drawQr, fitTextBlock, roundedRect, setFont, shareImageFile, truncateToWidth } from "./cardCanvas.js";
import { memberQrText } from "../checkin.js";

export { cardFontFamilies, fitTextBlock, fontHasGlyph } from "./cardCanvas.js";
import {
    DEFAULT_WELCOME_TEMPLATES,
    WELCOME_LANGUAGES,
    buildWelcomeMessage,
    paymentPlaceholderValues,
    welcomeLanguage,
    welcomePayment,
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

// ---------- Fee and payments, read from the database ----------

// Per member id: { status: "loading" | "ready" | "error", memberships, payments, message }.
export const welcomeFacts = {};

/** Loads the member's memberships and payments from the API (not browser state). */
export async function loadWelcomeFacts(memberId) {
    welcomeFacts[memberId] = { status: "loading", memberships: [], payments: [] };
    try {
        const [memberships, payments] = await Promise.all([
            apiClient.get(`/api/members/${memberId}/memberships`),
            apiClient.get(`/api/payments/member/${memberId}`)
        ]);
        welcomeFacts[memberId] = {
            status: "ready",
            memberships: Array.isArray(memberships?.data) ? memberships.data : [],
            payments: Array.isArray(payments?.data) ? payments.data : []
        };
    } catch (error) {
        welcomeFacts[memberId] = { status: "error", memberships: [], payments: [], message: error.message || "Fee details could not be loaded." };
    }
    return welcomeFacts[memberId];
}

/**
 * The membership as stored in the database (matched by id) and the payments to use.
 * Explicit payments win; otherwise the loaded database rows; otherwise none, so fee lines are left out.
 */
function resolveFacts(member, membership, payments) {
    const facts = welcomeFacts[member?.id];
    if (facts?.status !== "ready") return { membership, payments };
    const stored = facts.memberships.find((row) => row.id === membership?.id) || membership;
    return { membership: stored, payments: payments ?? facts.payments };
}

/** Fee, paid and balance for the member's membership, or null when unknown. */
export function welcomePaymentFor(member, { membership = member?.currentMembership, payments } = {}) {
    const resolved = resolveFacts(member, membership, payments);
    return resolved.payments ? welcomePayment(resolved.membership, resolved.payments) : null;
}

/** Placeholder values for one member. Missing values stay empty so their lines are left out. */
export function welcomeValues(member, { membership = member?.currentMembership, gym = state.gym, payments } = {}) {
    const resolved = resolveFacts(member, membership, payments);
    const payment = resolved.payments ? welcomePayment(resolved.membership, resolved.payments) : null;
    return {
        name: member?.name || "",
        gym_name: gym?.name || "",
        plan: resolved.membership?.plan_name || "",
        start_date: dateText(resolved.membership?.start_date || member?.startDate),
        expiry_date: dateText(resolved.membership?.end_date || member?.expiryDate),
        member_code: member?.memberCode || "",
        gym_phone: gym?.phone || "",
        gym_address: gym?.address || "",
        ...paymentPlaceholderValues(payment, formatINR)
    };
}

/** "" when a welcome may be sent, otherwise why not: "no-consent" or "invalid-phone". */
export function welcomeBlocker(member) {
    if (member?.whatsappOptIn !== true) return "no-consent";
    return welcomePhone(member.phone) ? "" : "invalid-phone";
}

export function welcomeMessageFor(member, { membership, gym, payments, language = welcomeMessageLanguage() } = {}) {
    return buildWelcomeMessage(welcomeTemplate(language), welcomeValues(member, { membership, gym, payments }));
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
export function sendWelcome(member, { membership, gym, payments, language = welcomeMessageLanguage(), open = openInWhatsApp, record = recordWelcomeOnApi } = {}) {
    const blocker = welcomeBlocker(member);
    if (blocker === "no-consent") throw new Error("This member has not agreed to receive WhatsApp updates.");
    if (blocker) throw new Error("This member does not have a valid Indian mobile number.");
    const message = welcomeMessageFor(member, { membership, gym, payments, language });
    open(welcomeWhatsAppUrl(member.phone, message));
    return record(member.id, { reminder_type: "welcome", language: welcomeLanguage(language), body: message });
}

// ---------- The welcome card image ----------

// Portrait, so the check-in QR is large enough to scan from the member's phone screen.
export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;
const CARD_LABELS = {
    en: { welcome: "Welcome,", memberCard: "Member card", plan: "Plan", start: "Starts", expiry: "Valid until", fee: "Fee", paid: "Paid", balance: "Balance due", paidInFull: "Paid in full", code: "MEMBER ID", scan: "Show this QR at the front desk to check in" },
    hi: { welcome: "स्वागत है,", memberCard: "सदस्य कार्ड", plan: "योजना", start: "शुरुआत", expiry: "वैध तिथि", fee: "शुल्क", paid: "भुगतान", balance: "बकाया", paidInFull: "पूरा भुगतान", code: "सदस्य आईडी", scan: "चेक-इन के लिए यह QR रिसेप्शन पर दिखाएँ" },
    mr: { welcome: "स्वागत आहे,", memberCard: "सदस्य कार्ड", plan: "योजना", start: "सुरुवात", expiry: "वैध तारीख", fee: "शुल्क", paid: "भरले", balance: "बाकी", paidInFull: "पूर्ण भरले", code: "सदस्य आयडी", scan: "चेक-इनसाठी हा QR रिसेप्शनवर दाखवा" }
};

/** The member's check-in QR token; lists do not carry it, so it is fetched once when missing. */
export async function ensureQrToken(member) {
    if (!member?.id) return "";
    if (member.qrToken) return member.qrToken;
    try {
        const response = await apiClient.get(`/api/members/${member.id}`);
        const token = response?.data?.qr_token || "";
        if (token) {
            member.qrToken = token;
            const stored = state.members.find((item) => item.id === member.id);
            if (stored) stored.qrToken = token;
        }
        return token;
    } catch {
        return "";
    }
}


/** The rows under the name: plan, dates, then fee, paid and balance when known. */
function cardRows(labels, values, payment) {
    const rows = [
        { label: labels.plan, value: values.plan, maxLines: 2 },
        { label: labels.start, value: values.start_date },
        { label: labels.expiry, value: values.expiry_date }
    ];
    if (payment) {
        rows.push({ label: labels.fee, value: formatINR(payment.fee), money: true });
        if (payment.hasPayment) {
            rows.push({ label: labels.paid, value: values.amount_paid, money: true });
            rows.push(payment.balance > 0
                ? { label: labels.balance, value: formatINR(payment.balance), money: true, pill: CARD_COLORS.brick }
                : { label: "", value: labels.paidInFull, pill: CARD_COLORS.leaf });
        }
    }
    return rows.filter((row) => row.value);
}

/**
 * Draws the 1080x1350 welcome card (or, with variant "member", the member card) with the
 * member's check-in QR, and resolves to a PNG file. The gym phone is not shown.
 */
export async function createWelcomeCard(member, { membership = member?.currentMembership, gym = state.gym, payments, language = welcomeMessageLanguage(), variant = "welcome" } = {}) {
    const labels = CARD_LABELS[welcomeLanguage(language)];
    const token = await ensureQrToken(member);
    const qrText = token ? memberQrText(token) : "";
    const values = welcomeValues(member, { membership, gym, payments });
    // The member card shows the plan and dates only; fees belong on the welcome card.
    const payment = variant === "member" ? null : welcomePaymentFor(member, { membership, payments });
    const rows = cardRows(labels, values, payment);
    await cardFontsReady([values.gym_name, values.name, values.member_code, ...Object.values(labels), ...rows.map((row) => row.value), "₹0123456789,"].join(" "));

    const canvas = document.createElement("canvas");
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot draw the welcome card.");
    const fonts = cardFontFamilies(context);
    const pad = 88;
    const width = CARD_WIDTH - pad * 2;
    const footerTop = CARD_HEIGHT - 140;
    // The QR block sits just above the member-ID band.
    let qrBox = 360;
    const captionBaseline = footerTop - 34;
    let qrTop = captionBaseline - 46 - qrBox;
    context.textBaseline = "alphabetic";

    context.fillStyle = CARD_COLORS.slate;
    context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
    context.fillStyle = CARD_COLORS.marigold;
    context.fillRect(0, 0, CARD_WIDTH, 16);

    // Rows first: their height decides how much room the name gets.
    const rowGap = 14;
    const panelPad = 26;
    const laidOut = rows.map((row) => {
        setFont(context, 400, 30, fonts.body);
        const labelWidth = row.label ? Math.min(context.measureText(row.label).width, width * 0.45) : 0;
        const valueWidth = width - labelWidth - (row.label ? 32 : 0) - (row.pill ? 40 : 0);
        const value = fitTextBlock(context, row.value, { weight: 700, family: fonts.heading, max: 40, min: 26, width: valueWidth, maxLines: row.maxLines || 1 });
        const height = Math.max(row.pill ? 54 : 44, value.lines.length * value.lineHeight);
        return { ...row, labelWidth, value, height };
    });
    const panelHeight = laidOut.length ? panelPad * 2 + laidOut.reduce((sum, row) => sum + row.height, 0) + rowGap * (laidOut.length - 1) : 0;
    let panelBottom = qrText ? qrTop - 32 : footerTop - 28;
    let panelTop = panelBottom - panelHeight;

    let y = 64;
    const gymName = fitTextBlock(context, values.gym_name || "GymPulse", { weight: 700, family: fonts.heading, max: 52, min: 30, width, maxLines: 2, maxHeight: 130 });
    context.fillStyle = CARD_COLORS.marigold;
    setFont(context, 700, gymName.size, fonts.heading);
    gymName.lines.forEach((line) => { y += gymName.lineHeight; context.fillText(line, pad, y); });
    context.fillRect(pad, y + 22, 120, 8);
    y += 30 + 36;

    context.fillStyle = CARD_COLORS.soft;
    setFont(context, 500, 40, fonts.body);
    y += 40;
    context.fillText(variant === "member" ? labels.memberCard : labels.welcome, pad, y);
    y += 14;

    // A two-line gym name, a long member name and six rows can crowd the card: the QR gives up
    // size first (down to 260 px, still easy to scan) so the name keeps room for two lines.
    const nameNeeds = 120;
    if (qrText && panelTop < y + nameNeeds) {
        qrBox = Math.max(260, qrBox - (y + nameNeeds - panelTop));
        qrTop = captionBaseline - 46 - qrBox;
        panelBottom = qrTop - 32;
        panelTop = panelBottom - panelHeight;
    }

    const nameSpace = Math.max(60, panelTop - 36 - y);
    const name = fitTextBlock(context, values.name, { weight: 800, family: fonts.heading, max: 104, min: 34, width, maxLines: 2, maxHeight: nameSpace, lineHeight: 1.08 });
    context.fillStyle = CARD_COLORS.white;
    setFont(context, 800, name.size, fonts.heading);
    name.lines.forEach((line) => { y += name.lineHeight; context.fillText(line, pad, y); });

    if (laidOut.length) {
        context.fillStyle = CARD_COLORS.slate2;
        roundedRect(context, pad - 28, panelTop, width + 56, panelHeight, 24);
        context.fill();
        let rowTop = panelTop + panelPad;
        for (const row of laidOut) {
            const middle = rowTop + row.height / 2;
            if (row.label) {
                context.fillStyle = CARD_COLORS.soft;
                setFont(context, 400, 30, fonts.body);
                context.textAlign = "left";
                context.fillText(truncateToWidth(context, row.label, row.labelWidth), pad, middle + 10);
            }
            setFont(context, 700, row.value.size, fonts.heading);
            context.textAlign = "right";
            if (row.pill) {
                const textWidth = context.measureText(row.value.lines[0]).width;
                context.fillStyle = row.pill;
                roundedRect(context, pad + width - textWidth - 40, middle - 27, textWidth + 40, 54, 27);
                context.fill();
                context.fillStyle = CARD_COLORS.white;
                context.fillText(row.value.lines[0], pad + width - 20, middle + row.value.size * 0.34);
            } else {
                context.fillStyle = CARD_COLORS.white;
                const first = middle - ((row.value.lines.length - 1) * row.value.lineHeight) / 2 + row.value.size * 0.34;
                row.value.lines.forEach((line, index) => context.fillText(line, pad + width, first + index * row.value.lineHeight));
            }
            rowTop += row.height + rowGap;
        }
        context.textAlign = "left";
    }

    if (qrText) {
        context.fillStyle = CARD_COLORS.white;
        roundedRect(context, (CARD_WIDTH - qrBox) / 2, qrTop, qrBox, qrBox, 24);
        context.fill();
        drawQr(context, qrText, (CARD_WIDTH - qrBox) / 2 + 12, qrTop + 12, qrBox - 24);
        const caption = fitTextBlock(context, labels.scan, { weight: 500, family: fonts.body, max: 32, min: 22, width });
        context.fillStyle = CARD_COLORS.soft;
        setFont(context, 500, caption.size, fonts.body);
        context.textAlign = "center";
        context.fillText(caption.lines[0], CARD_WIDTH / 2, captionBaseline);
        context.textAlign = "left";
    }

    context.fillStyle = CARD_COLORS.marigold;
    context.fillRect(0, footerTop, CARD_WIDTH, CARD_HEIGHT - footerTop);
    context.fillStyle = CARD_COLORS.slate;
    setFont(context, 500, 32, fonts.body);
    context.fillText(labels.code, pad, footerTop + 84);
    if (values.member_code) {
        const codeWidth = width - context.measureText(labels.code).width - 32;
        const code = fitTextBlock(context, values.member_code, { weight: 800, family: fonts.heading, max: 56, min: 28, width: codeWidth });
        setFont(context, 800, code.size, fonts.heading);
        context.textAlign = "right";
        context.fillText(code.lines[0], pad + width, footerTop + 90);
        context.textAlign = "left";
    }

    const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("The welcome card image could not be created.")), "image/png"));
    const fileName = `${variant === "member" ? "member-card" : "welcome"}-${String(values.member_code || "member").replace(/[^A-Za-z0-9-]/g, "")}.png`;
    return new File([blob], fileName, { type: "image/png" });
}

/** Shares the welcome card (share sheet on phones, download on desktop). */
export const shareWelcomeCard = shareImageFile;
