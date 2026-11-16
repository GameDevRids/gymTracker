// The expiry reminder sent from "Expiring soon" through wa.me (click-to-chat). Saved per gym and
// language in the database, like the welcome message. This file has no DOM or browser-state
// imports, so the server validates saved messages with the same rules.

export const REMINDER_LANGUAGES = ["en", "hi", "mr"];
// {grace_date}: the last day of grace after the plan ends (migration 020).
export const REMINDER_PLACEHOLDERS = ["name", "plan", "expiry_date", "grace_date"];
export const REMINDER_TEMPLATE_MAX_LENGTH = 1000;

export const DEFAULT_REMINDER_TEMPLATES = {
    en: "Hi {name}, your {plan} membership is valid till {expiry_date} (grace till {grace_date}). Renew to keep training without a break. We would love to see you again!",
    hi: "नमस्ते {name}, आपकी {plan} सदस्यता {expiry_date} तक मान्य है (ग्रेस {grace_date} तक)। बिना रुके ट्रेनिंग जारी रखने के लिए नवीनीकरण करें। हम आपको फिर से देखना चाहेंगे!",
    mr: "नमस्कार {name}, तुमची {plan} सदस्यता {expiry_date} पर्यंत वैध आहे (ग्रेस {grace_date} पर्यंत). खंड न पडता व्यायाम सुरू ठेवण्यासाठी नूतनीकरण करा. आम्हाला तुम्हाला पुन्हा भेटायला आवडेल!"
};

export function reminderLanguage(language) {
    return REMINDER_LANGUAGES.includes(language) ? language : "en";
}

/** "" when the message can be saved, otherwise what to fix. */
export function reminderTemplateProblem(body) {
    if (typeof body !== "string" || !body.trim()) return "Enter a reminder message.";
    if (body.length > REMINDER_TEMPLATE_MAX_LENGTH) return `Keep the reminder message to ${REMINDER_TEMPLATE_MAX_LENGTH} characters or fewer.`;
    const unknown = [...body.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]).find((key) => !REMINDER_PLACEHOLDERS.includes(key));
    if (unknown !== undefined) return `Unsupported placeholder: {${unknown}}. Use {name}, {plan}, {expiry_date} or {grace_date}.`;
    return "";
}

/** Fills {name}, {plan}, {expiry_date} and {grace_date}; other text is left as it is. */
export function buildReminderMessage(template, values = {}) {
    return String(template ?? "").replace(/\{(name|plan|expiry_date|grace_date)\}/g, (_match, key) => String(values[key] ?? "").trim());
}
