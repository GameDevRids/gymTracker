// Welcome message templates and filling. No DOM or storage access, so the browser and the
// server tests share this file. A Cloud API version would map the same values onto the
// numbered parameters of an approved Meta template.

export const WELCOME_LANGUAGES = ["en", "hi", "mr"];

export const WELCOME_PLACEHOLDERS = ["name", "gym_name", "plan", "start_date", "expiry_date", "member_code", "gym_phone", "gym_address"];

export const WELCOME_TEMPLATE_MAX_LENGTH = 1000;

// One sentence per line, so a line whose placeholder has no value can be left out on its own.
export const DEFAULT_WELCOME_TEMPLATES = {
    en: [
        "Hi {name}, welcome to {gym_name}! 💪",
        "Your {plan} membership is active from {start_date} to {expiry_date}.",
        "Member ID: {member_code}.",
        "For any help, call us at {gym_phone}.",
        "See you at the gym!"
    ].join("\n"),
    hi: [
        "नमस्ते {name}, {gym_name} में आपका स्वागत है! 💪",
        "आपकी {plan} सदस्यता {start_date} से {expiry_date} तक सक्रिय है।",
        "सदस्य आईडी: {member_code}",
        "किसी भी मदद के लिए हमें {gym_phone} पर कॉल करें।",
        "जिम में मिलते हैं!"
    ].join("\n"),
    mr: [
        "नमस्कार {name}, {gym_name} मध्ये आपले स्वागत आहे! 💪",
        "आपले {plan} सदस्यत्व {start_date} पासून {expiry_date} पर्यंत सक्रिय आहे.",
        "सदस्य आयडी: {member_code}",
        "कोणत्याही मदतीसाठी आम्हाला {gym_phone} वर कॉल करा.",
        "जिममध्ये भेटूया!"
    ].join("\n")
};

const PLACEHOLDER_PATTERN = /\{([a-z_]+)\}/g;

export function welcomeLanguage(language) {
    return WELCOME_LANGUAGES.includes(language) ? language : "en";
}

/** Returns "" for a usable template, otherwise the reason it is rejected. */
export function welcomeTemplateProblem(body) {
    if (typeof body !== "string" || !body.trim()) return "Enter a welcome message.";
    if (body.length > WELCOME_TEMPLATE_MAX_LENGTH) return `Keep the welcome message to ${WELCOME_TEMPLATE_MAX_LENGTH} characters or fewer.`;
    const unknown = [...body.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]).find((key) => !WELCOME_PLACEHOLDERS.includes(key));
    if (unknown !== undefined) return `Unsupported placeholder: {${unknown}}.`;
    return "";
}

/**
 * Fills a welcome template. A line that uses a placeholder with no value (for example no gym
 * phone) is left out entirely rather than sent half-empty. Blank lines left behind are collapsed.
 */
export function buildWelcomeMessage(template, values = {}) {
    const text = (key) => String(values[key] ?? "").trim();
    const lines = [];
    for (const line of String(template ?? "").replace(/\r\n?/g, "\n").split("\n")) {
        const keys = [...line.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]).filter((key) => WELCOME_PLACEHOLDERS.includes(key));
        if (keys.some((key) => !text(key))) continue;
        const filled = line.replace(PLACEHOLDER_PATTERN, (match, key) => WELCOME_PLACEHOLDERS.includes(key) ? text(key) : match).trimEnd();
        if (!filled.trim() && (!lines.length || !lines[lines.length - 1].trim())) continue;
        lines.push(filled);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join("\n");
}

/** A 10-digit Indian mobile number from what the member record holds, or "". */
export function welcomePhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "").replace(/^0(?=\d{10}$)/, "");
    return /^[6-9]\d{9}$/.test(digits) ? digits : "";
}

export function welcomeWhatsAppUrl(phone, message) {
    const digits = welcomePhone(phone);
    if (!digits) throw new Error("This member does not have a valid Indian mobile number.");
    return `https://wa.me/91${digits}?text=${encodeURIComponent(message)}`;
}
