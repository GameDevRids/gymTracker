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
