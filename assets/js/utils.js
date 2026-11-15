export const escapeHTML = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);

// The gym's date format, saved in the database (Settings) and set after sign-in.
let configuredDateFormat = "DD MMM YYYY";
export function setDateFormat(format) {
    configuredDateFormat = format === "DD/MM/YYYY" ? format : "DD MMM YYYY";
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

/** A check-in's gym day (India time): the database's check_in_date, or worked out from the time. */
export function visitDay(record) {
    if (record?.checkInDate) return record.checkInDate;
    const time = new Date(record?.checkedInAt || "");
    return Number.isNaN(time.getTime()) ? "" : indiaISODate(time);
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

/**
 * A CSV cell. Text starting with = + - @ (or a tab or carriage return) gets a leading
 * apostrophe so spreadsheet apps show it as text instead of running it as a formula.
 * Numbers are left alone, so negative amounts stay numbers.
 */
export function csvCell(value) {
    const text = String(value ?? "");
    const safe = typeof value === "string" && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
}

/** Saves bytes or text as a file on this device (for example an .xlsx from spreadsheet.js). */
export function downloadFile(filename, content, type = "application/octet-stream") {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCSV(filename, rows) {
    if (!rows.length) throw new Error("There are no records to export.");
    const headers = Object.keys(rows[0]);
    const quote = csvCell;
    const csv = [headers.map(quote).join(","), ...rows.map((row) => headers.map((header) => quote(row[header])).join(","))].join("\r\n");
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

export const monthKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
