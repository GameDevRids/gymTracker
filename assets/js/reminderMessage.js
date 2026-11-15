// The expiry reminder sent from "Expiring soon" through wa.me (click-to-chat). Saved per gym and
// language in the database, like the welcome message. This file has no DOM or browser-state
// imports, so the server validates saved messages with the same rules.

export const REMINDER_LANGUAGES = ["en", "hi", "mr"];
export const REMINDER_PLACEHOLDERS = ["name", "plan", "expiry_date"];
export const REMINDER_TEMPLATE_MAX_LENGTH = 1000;

export const DEFAULT_REMINDER_TEMPLATES = {
    en: "Hi {name}, your {plan} membership expires on {expiry_date}. We would love to see you again!",
    hi: "नमस्ते {name}, आपकी {plan} सदस्यता {expiry_date} को समाप्त हो रही है। हम आपको फिर से देखना चाहेंगे!",
    mr: "नमस्कार {name}, तुमची {plan} सदस्यता {expiry_date} रोजी संपत आहे. आम्हाला तुम्हाला पुन्हा भेटायला आवडेल!"
};

export function reminderLanguage(language) {
    return REMINDER_LANGUAGES.includes(language) ? language : "en";
}

/** "" when the message can be saved, otherwise what to fix. */
export function reminderTemplateProblem(body) {
    if (typeof body !== "string" || !body.trim()) return "Enter a reminder message.";
    if (body.length > REMINDER_TEMPLATE_MAX_LENGTH) return `Keep the reminder message to ${REMINDER_TEMPLATE_MAX_LENGTH} characters or fewer.`;
    const unknown = [...body.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]).find((key) => !REMINDER_PLACEHOLDERS.includes(key));
    if (unknown !== undefined) return `Unsupported placeholder: {${unknown}}. Use {name}, {plan} or {expiry_date}.`;
    return "";
}

/** Fills {name}, {plan} and {expiry_date}; other text is left as it is. */
export function buildReminderMessage(template, values = {}) {
    return String(template ?? "").replace(/\{(name|plan|expiry_date)\}/g, (_match, key) => String(values[key] ?? "").trim());
}
