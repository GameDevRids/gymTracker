// Enquiries: people who visited the gym and might join (migration 024). The rules shared by the server
// and the app: cleaning a phone number, the follow-up quick dates, which tab an enquiry is on, whether
// its follow-up is overdue, the WhatsApp message, and this month's numbers. India dates (YYYY-MM-DD)
// throughout. No DOM or app imports.

export const ENQUIRY_SOURCES = [["walk_in", "Walk-in"], ["instagram", "Instagram"], ["friend", "Friend"], ["other", "Other"]];
export const ENQUIRY_STAGES = { new: "New", contacted: "Contacted", joined: "Joined", not_interested: "Not interested" };
export const OPEN_STAGES = ["new", "contacted"];
export const ENQUIRY_TABS = ["today", "open", "joined", "not_interested"];
export const ENQUIRY_KEEP_DAYS = 90;

export function sourceLabel(source) {
    return ENQUIRY_SOURCES.find(([value]) => value === source)?.[1] || "Other";
}

/**
 * A 10-digit Indian mobile from "+91 98765 43210", "098765-43210", "919876543210" or "9876543210".
 * Returns "+919876543210", or "" when it is not a mobile number.
 */
export function cleanEnquiryPhone(value) {
    let digits = String(value ?? "").replace(/[\s\-().]/g, "");
    if (/[^\d+]/.test(digits)) return "";
    digits = digits.replace(/^\+/, "");
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    else if (digits.length === 13 && digits.startsWith("091")) digits = digits.slice(3);
    return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : "";
}

/** The last 10 digits, to compare with a member's phone. */
export function last10(phone) {
    return String(phone ?? "").replace(/\D/g, "").slice(-10);
}

function plusDays(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

/** Tomorrow, In 3 days and Next week (7 days), from today. */
export function followUpChoices(today) {
    return [["tomorrow", "Tomorrow", plusDays(today, 1)], ["three", "In 3 days", plusDays(today, 3)], ["week", "Next week", plusDays(today, 7)]];
}

export const isOpen = (enquiry) => OPEN_STAGES.includes(enquiry?.stage);

/** "overdue", "today", "later" or "none", for an open enquiry's follow-up date. */
export function followUpState(enquiry, today) {
    if (!isOpen(enquiry) || !enquiry.follow_up_on) return "none";
    const day = String(enquiry.follow_up_on).slice(0, 10);
    return day < today ? "overdue" : day === today ? "today" : "later";
}

/** Due: an open enquiry whose follow-up is today or overdue (the badge, Today, the first tab). */
export const isDue = (enquiry, today) => ["overdue", "today"].includes(followUpState(enquiry, today));

/** The enquiries on a tab: Follow up today (due today or overdue) | All open | Joined | Not interested. */
export function enquiriesOnTab(enquiries, tab, today) {
    const list = enquiries || [];
    if (tab === "today") return list.filter((enquiry) => isDue(enquiry, today)).sort((a, b) => String(a.follow_up_on).localeCompare(String(b.follow_up_on)));
    if (tab === "open") return list.filter(isOpen).sort((a, b) => String(a.follow_up_on || "9999").localeCompare(String(b.follow_up_on || "9999")) || String(b.created_at).localeCompare(String(a.created_at)));
    return list.filter((enquiry) => enquiry.stage === tab).sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
}

export function tabCounts(enquiries, today) {
    return Object.fromEntries(ENQUIRY_TABS.map((tab) => [tab, enquiriesOnTab(enquiries, tab, today).length]));
}

/** The India date of a timestamp. */
export function indiaDay(timestamp) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

/**
 * This month's numbers (India calendar month): enquiries made this month, how many of those joined,
 * and the conversion (joined ÷ enquiries, a whole percent; null with no enquiries). By source too.
 */
export function monthStats(enquiries, today) {
    const month = today.slice(0, 7);
    const mine = (enquiries || []).filter((enquiry) => indiaDay(enquiry.created_at).slice(0, 7) === month);
    const joined = mine.filter((enquiry) => enquiry.stage === "joined").length;
    const rate = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
    return {
        month,
        enquiries: mine.length,
        joined,
        conversion: rate(joined, mine.length),
        bySource: ENQUIRY_SOURCES.map(([source, label]) => {
            const rows = mine.filter((enquiry) => enquiry.source === source);
            const sourceJoined = rows.filter((enquiry) => enquiry.stage === "joined").length;
            return { source, label, enquiries: rows.length, joined: sourceJoined, conversion: rate(sourceJoined, rows.length) };
        })
    };
}

// ---------- The WhatsApp message (a template, editable in Settings > Messages) ----------

export const ENQUIRY_LANGUAGES = ["en", "hi", "mr"];
export const ENQUIRY_PLACEHOLDERS = ["name", "gym_name", "gym_phone"];
export const ENQUIRY_TEMPLATE_MAX_LENGTH = 1000;
export const DEFAULT_ENQUIRY_TEMPLATES = {
    en: "Hi {name}, thanks for visiting {gym_name}! Would you like to join? {gym_phone}",
    hi: "नमस्ते {name}, {gym_name} आने के लिए धन्यवाद! क्या आप जुड़ना चाहेंगे? {gym_phone}",
    mr: "नमस्कार {name}, {gym_name} ला भेट दिल्याबद्दल धन्यवाद! तुम्हाला सामील व्हायला आवडेल का? {gym_phone}"
};

export function enquiryLanguage(language) {
    return ENQUIRY_LANGUAGES.includes(language) ? language : "en";
}

/** "" when the message can be saved, otherwise what to fix. */
export function enquiryTemplateProblem(body) {
    if (typeof body !== "string" || !body.trim()) return "Enter the enquiry message.";
    if (body.length > ENQUIRY_TEMPLATE_MAX_LENGTH) return `Keep the enquiry message to ${ENQUIRY_TEMPLATE_MAX_LENGTH} characters or fewer.`;
    const unknown = [...body.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]).find((key) => !ENQUIRY_PLACEHOLDERS.includes(key));
    if (unknown !== undefined) return `Unsupported placeholder: {${unknown}}. Use {name}, {gym_name} or {gym_phone}.`;
    return "";
}

/** Fills {name} (first name), {gym_name} and {gym_phone}; a missing value leaves nothing behind. */
export function buildEnquiryMessage(template, { name = "", gymName = "", gymPhone = "" } = {}) {
    const first = String(name).trim().split(/\s+/)[0] || "there";
    const values = { name: first, gym_name: String(gymName).trim() || "our gym", gym_phone: String(gymPhone).trim() };
    return String(template ?? "").replace(/\{(name|gym_name|gym_phone)\}/g, (_all, key) => values[key]).replace(/[ \t]+$/gm, "").trim();
}
