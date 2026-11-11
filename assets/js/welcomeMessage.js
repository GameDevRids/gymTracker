// Welcome message templates and filling. No DOM or storage access, so the browser and the
// server tests share this file. A Cloud API version would map the same values onto the
// numbered parameters of an approved Meta template.

export const WELCOME_LANGUAGES = ["en", "hi", "mr"];

export const WELCOME_PLACEHOLDERS = ["name", "gym_name", "plan", "start_date", "expiry_date", "member_code", "gym_phone", "gym_address", "fee", "amount_paid", "balance"];

export const WELCOME_TEMPLATE_MAX_LENGTH = 1000;

// One sentence per line, so a line whose placeholder has no value can be left out on its own:
// no payment yet drops "Paid", and a fully paid membership drops "Balance".
export const DEFAULT_WELCOME_TEMPLATES = {
    en: [
        "Hi {name}, welcome to {gym_name}! 💪",
        "Your {plan} membership is active from {start_date} to {expiry_date}.",
        "Fee: {fee}.",
        "Paid: {amount_paid}.",
        "Balance due: {balance}.",
        "Member ID: {member_code}.",
        "For any help, call us at {gym_phone}.",
        "See you at the gym!"
    ].join("\n"),
    hi: [
        "नमस्ते {name}, {gym_name} में आपका स्वागत है! 💪",
        "आपकी {plan} सदस्यता {start_date} से {expiry_date} तक सक्रिय है।",
        "शुल्क: {fee}",
        "भुगतान: {amount_paid}",
        "बकाया राशि: {balance}",
        "सदस्य आईडी: {member_code}",
        "किसी भी मदद के लिए हमें {gym_phone} पर कॉल करें।",
        "जिम में मिलते हैं!"
    ].join("\n"),
    mr: [
        "नमस्कार {name}, {gym_name} मध्ये आपले स्वागत आहे! 💪",
        "आपले {plan} सदस्यत्व {start_date} पासून {expiry_date} पर्यंत सक्रिय आहे.",
        "शुल्क: {fee}",
        "भरलेली रक्कम: {amount_paid}",
        "बाकी रक्कम: {balance}",
        "सदस्य आयडी: {member_code}",
        "कोणत्याही मदतीसाठी आम्हाला {gym_phone} वर कॉल करा.",
        "जिममध्ये भेटूया!"
    ].join("\n")
};

const PAYMENT_METHOD_LABELS = { upi: "UPI", cash: "Cash", card: "Card", other: "Other" };

function money(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

/**
 * Fee, paid and balance for one membership, from database rows: the membership's billed fee
 * (total_fees, else the plan price) and the payments recorded against that membership.
 * Returns null when there is no membership or no fee.
 */
export function welcomePayment(membership, payments = []) {
    const rawFee = membership?.total_fees ?? membership?.price;
    if (!membership || rawFee === null || rawFee === undefined || rawFee === "" || !Number.isFinite(Number(rawFee))) return null;
    const fee = money(rawFee);
    const linked = (Array.isArray(payments) ? payments : []).filter((payment) => payment.membership_id && payment.membership_id === membership.id);
    const paid = money(linked.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
    const methods = [...new Set(linked.map((payment) => PAYMENT_METHOD_LABELS[payment.method] || String(payment.method || "")).filter(Boolean))];
    return { fee, paid, balance: Math.max(0, money(fee - paid)), methods, hasPayment: paid > 0 };
}

/** {fee}, {amount_paid} and {balance}. Empty when not applicable, so their lines are left out. */
export function paymentPlaceholderValues(payment, formatMoney) {
    if (!payment) return { fee: "", amount_paid: "", balance: "" };
    return {
        fee: formatMoney(payment.fee),
        amount_paid: payment.hasPayment ? `${formatMoney(payment.paid)}${payment.methods.length ? ` (${payment.methods.join(", ")})` : ""}` : "",
        balance: payment.hasPayment && payment.balance > 0 ? formatMoney(payment.balance) : ""
    };
}

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
