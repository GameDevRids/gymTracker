export const escapeHTML = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);

let configuredDateFormat = "DD MMM YYYY";
let configuredCurrency = "INR";
export function setDateFormat(format) {
    configuredDateFormat = format;
}

export function setCurrency(currency) {
    configuredCurrency = currency;
}

export function uid(prefix = "ID") {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export function localISODate(date = new Date()) {
    const value = new Date(date);
    value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
    return value.toISOString().slice(0, 10);
}

export function indiaISODate(date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(date);
}

export function addDays(dateString, days) {
    const date = new Date(`${dateString}T12:00:00`);
    date.setDate(date.getDate() + Number(days));
    return localISODate(date);
}

export function daysBetween(from, to = localISODate()) {
    if (!from) return null;
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    return Math.floor((end - start) / 86400000);
}

export function formatDate(dateString, format = configuredDateFormat) {
    if (!dateString) return "—";
    const date = new Date(`${dateString.slice(0, 10)}T12:00:00`);
    if (Number.isNaN(date.getTime())) return "—";
    if (format === "DD/MM/YYYY") return new Intl.DateTimeFormat("en-IN").format(date);
    return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

export function formatCurrency(amount, currency = configuredCurrency) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency", currency, maximumFractionDigits: 0
    }).format(Number(amount) || 0);
}

export function formatINR(amount) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0
    }).format(Number(amount) || 0);
}

export function isValidIndianPhone(value) {
    return /^(?:\+91)?[6-9]\d{9}$/.test(String(value || "").trim());
}

export function normalizeIndianPhone(value) {
    const phone = String(value || "").trim();
    return phone.startsWith("+91") ? phone.slice(3) : phone;
}

/** Plan length for display: "1 month (30 days)", "12 months (365 days)", or "45 days". */
export function formatPlanDuration(days) {
    const count = Number(days);
    if (!Number.isFinite(count) || count <= 0) return "";
    const months = count === 365 ? 12 : count % 30 === 0 ? count / 30 : 0;
    const dayText = `${count} day${count === 1 ? "" : "s"}`;
    return months ? `${months} month${months === 1 ? "" : "s"} (${dayText})` : dayText;
}

/** Shows an Indian mobile number as "+91 98230 12345". Anything else is returned unchanged. */
export function formatPhone(value) {
    const raw = String(value ?? "").trim();
    let digits = raw.replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    return /^[6-9]\d{9}$/.test(digits) ? `+91 ${digits.slice(0, 5)} ${digits.slice(5)}` : raw;
}

// Member names: letters in any script (with combining marks for Devanagari), separated by
// spaces, dots, apostrophes or hyphens. The server applies the same rule in validateMember.js.
export const MEMBER_NAME_MAX_LENGTH = 200;
const MEMBER_NAME_PATTERN = /^[\p{L}\p{M}]+(?:[ .'’-]+[\p{L}\p{M}]+)*\.?$/u;

export function cleanMemberName(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ");
}

/** Returns "" for a valid name, otherwise "missing", "email", "too-long" or "invalid". */
export function memberNameIssue(value) {
    const name = cleanMemberName(value);
    if (!name) return "missing";
    if (name.includes("@")) return "email";
    if (name.length > MEMBER_NAME_MAX_LENGTH) return "too-long";
    return MEMBER_NAME_PATTERN.test(name) ? "" : "invalid";
}

export const MEMBER_NAME_MESSAGES = {
    missing: "Enter the member's name.",
    email: "Enter the member's name, not an email address.",
    "too-long": `Name must be ${MEMBER_NAME_MAX_LENGTH} characters or fewer.`,
    invalid: "Use letters for the name. Spaces, dots, apostrophes and hyphens are allowed."
};

export function memberStatus(member) {
    const expiry = daysBetween(member.expiryDate);
    if (member.status === "suspended") return "suspended";
    return expiry !== null && expiry > 0 ? "expired" : "active";
}

export function statusPill(status) {
    const label = status ? status[0].toUpperCase() + status.slice(1) : "Unknown";
    return `<span class="status status-${escapeHTML(status || "inactive")}">${escapeHTML(label)}</span>`;
}

export function downloadCSV(filename, rows) {
    if (!rows.length) throw new Error("There are no records to export.");
    const headers = Object.keys(rows[0]);
    const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [headers.map(quote).join(","), ...rows.map((row) => headers.map((header) => quote(row[header])).join(","))].join("\r\n");
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

export function parseCSV(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    const input = text.replace(/^\uFEFF/, "");
    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        if (char === '"' && quoted && input[index + 1] === '"') { cell += '"'; index += 1; }
        else if (char === '"') quoted = !quoted;
        else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
        else if ((char === "\n" || char === "\r") && !quoted) {
            if (char === "\r" && input[index + 1] === "\n") index += 1;
            row.push(cell.trim()); cell = "";
            if (row.some(Boolean)) rows.push(row);
            row = [];
        } else cell += char;
    }
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
    if (quoted) throw new Error("CSV contains an unclosed quoted field.");
    if (rows.length < 2) throw new Error("CSV must include a header and at least one data row.");
    const headers = rows[0].map((header) => header.trim().toLowerCase().replace(/[\s_-]+/g, ""));
    return rows.slice(1).map((cells, index) => ({
        rowNumber: index + 2,
        data: Object.fromEntries(headers.map((header, column) => [header, cells[column] || ""]))
    }));
}

export const monthKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
