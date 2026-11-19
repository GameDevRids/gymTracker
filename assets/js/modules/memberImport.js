// Import members from an owner's spreadsheet: column matching, Indian phone and date formats,
// plans, duplicates and the list of what will be saved. No DOM or browser-state imports, so the
// same rules are tested in Node. The server checks everything again and saves in one go.
import { cleanMemberName, indiaISODate, memberNameIssue } from "../utils.js";
import { memberWarnings } from "../memberChecks.js";
import { excelSerialToDate } from "../spreadsheet.js";

export const IMPORT_MAX_ROWS = 2000;

export const IMPORT_FIELDS = [
    { key: "name", label: "Name", required: true, aliases: ["name", "full name", "member name", "member", "customer name", "client name", "naam", "नाम", "सदस्य"] },
    { key: "phone", label: "Phone", required: true, aliases: ["phone", "mobile", "mobile no", "mobile number", "phone number", "phone no", "contact", "contact no", "contact number", "whatsapp", "whatsapp number", "cell", "मोबाइल", "फोन"] },
    { key: "plan", label: "Plan", aliases: ["plan", "plan name", "membership", "membership plan", "package", "scheme", "type"] },
    { key: "startDate", label: "Start date", aliases: ["start date", "start", "from", "from date", "joining date", "date of joining", "doj", "joined", "join date", "admission date", "start from"] },
    { key: "endDate", label: "End date", aliases: ["end date", "end", "to", "to date", "expiry", "expiry date", "expires", "valid till", "valid upto", "valid up to", "due date", "renewal date", "till"] },
    { key: "amountPaid", label: "Amount paid", aliases: ["amount paid", "paid", "amount", "fees paid", "fee paid", "payment", "paid amount", "received", "fees"] },
    { key: "notes", label: "Notes", aliases: ["notes", "note", "remarks", "remark", "comments", "comment"] }
];

export const TEMPLATE_HEADERS = ["Name", "Phone", "Plan", "Start date", "End date", "Amount paid", "Notes"];

export function normalizeHeader(value) {
    return String(value ?? "").toLowerCase().replace(/[._:/()#*-]+/g, " ").replace(/\s+/g, " ").trim();
}

const cellText = (cell) => String(cell?.text ?? "").trim();
const isEmptyRow = (row) => !row || row.every((cell) => !cellText(cell));

/** The header row: the first of the first ten rows naming two known columns, else the first non-empty row. */
export function findHeaderRow(rows) {
    const aliases = new Set(IMPORT_FIELDS.flatMap((field) => field.aliases));
    for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
        const known = (rows[index] || []).filter((cell) => aliases.has(normalizeHeader(cellText(cell)))).length;
        if (known >= 2) return index;
    }
    const first = rows.findIndex((row) => !isEmptyRow(row));
    return first < 0 ? 0 : first;
}

/** For each field, the column index whose header matches it, or -1. A column is used once. */
export function guessColumns(headerRow = []) {
    const headers = headerRow.map((cell) => normalizeHeader(cellText(cell)));
    const used = new Set();
    const columns = {};
    // Exact names first, then names that contain a known word ("Mobile No." → Phone).
    for (const pass of ["exact", "contains"]) {
        for (const field of IMPORT_FIELDS) {
            if (columns[field.key] >= 0) continue;
            const index = headers.findIndex((header, column) => header && !used.has(column) && field.aliases.some((alias) => pass === "exact"
                ? header === alias
                : alias.length > 3 && (header.startsWith(`${alias} `) || header.endsWith(` ${alias}`))));
            columns[field.key] = index;
            if (index >= 0) used.add(index);
        }
    }
    return columns;
}

/** A 10-digit Indian mobile from +91 98765 43210, 098765-43210, 919876543210 or a number cell. */
export function importPhone(cell) {
    const text = cellText(cell);
    if (!text) return { phone: "", problem: "phone is missing" };
    if (/e\+?\d+$/i.test(text)) return { phone: "", problem: `phone ${text} was shortened by the spreadsheet; format the phone column as text and save again` };
    let digits = text.replace(/[\s\-().]/g, "");
    if (/[^\d+]/.test(digits)) return { phone: "", problem: `phone ${text} is not a mobile number` };
    digits = digits.replace(/^\+/, "");
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    else if (digits.length === 13 && digits.startsWith("091")) digits = digits.slice(3);
    return /^[6-9]\d{9}$/.test(digits)
        ? { phone: digits, problem: "" }
        : { phone: "", problem: `phone ${text} is not a 10-digit Indian mobile number` };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function realDate(year, month, day) {
    if (!(year >= 1990 && year <= 2100 && month >= 1 && month <= 12 && day >= 1)) return "";
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : "";
}

const fullYear = (text) => (text.length === 2 ? 2000 + Number(text) : Number(text));
const monthNumber = (name) => MONTHS.indexOf(String(name).slice(0, 3).toLowerCase()) + 1;

/**
 * "YYYY-MM-DD" from DD/MM/YYYY, DD-MM-YYYY, DD.MM.YY, 12 Jan 2026, 2026-01-12 or an Excel date.
 * Slashes and dashes are read day first, as in India.
 */
export function importDate(cell, { date1904 = false } = {}) {
    if (cell?.date) return { date: cell.date, problem: "" };
    const text = cellText(cell);
    if (!text) return { date: "", problem: "" };
    let match;
    let date = "";
    if ((match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})$/.exec(text))) date = realDate(fullYear(match[3]), Number(match[2]), Number(match[1]));
    else if ((match = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(text))) date = realDate(Number(match[1]), Number(match[2]), Number(match[3]));
    else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]*([A-Za-z]{3,9})[\s\-/.,']*(\d{4}|\d{2})$/.exec(text)) && monthNumber(match[2])) date = realDate(fullYear(match[3]), monthNumber(match[2]), Number(match[1]));
    else if ((match = /^([A-Za-z]{3,9})[\s\-/.]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\-/.]+(\d{4})$/.exec(text)) && monthNumber(match[1])) date = realDate(Number(match[3]), monthNumber(match[1]), Number(match[2]));
    else if (/^\d{5}(\.\d+)?$/.test(text)) {
        // An Excel date that lost its date format, for example in a CSV export.
        const serial = Number(text);
        if (serial >= 25000 && serial <= 80000) date = excelSerialToDate(serial, date1904);
    }
    return date ? { date, problem: "" } : { date: "", problem: `"${text}" is not a date we can read; use DD/MM/YYYY` };
}

/** Rupees from 1500, ₹1,500, Rs. 1500/-, 1500.50; blank is no payment. */
export function importAmount(cell) {
    const text = cellText(cell);
    if (!text) return { amount: 0, problem: "" };
    const cleaned = text.replace(/₹|rs\.?|inr|\/-|,|\s/gi, "");
    const amount = Number(cleaned);
    if (cleaned === "" || !Number.isFinite(amount) || amount < 0) return { amount: 0, problem: `amount paid "${text}" is not a number` };
    if (amount > 10000000) return { amount: 0, problem: `amount paid ${text} is too large` };
    return { amount: Math.round(amount * 100) / 100, problem: "" };
}

/** Plan names match whatever their case or spacing. */
export function planKey(name) {
    return String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

const NAME_PROBLEMS = {
    missing: "name is missing",
    email: "name looks like an email address",
    "too-long": "name is too long",
    invalid: "name must use letters (spaces, dots, apostrophes and hyphens are fine)"
};

function addDays(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

/** A guess of the plan length from its name ("Quarterly" → 90 days), or 0. */
export function guessPlanDays(name) {
    const key = planKey(name);
    const months = /(\d{1,2})\s*(?:months?|mon|mths?|m\b)/.exec(key);
    if (months) return Number(months[1]) === 12 ? 365 : Number(months[1]) * 30;
    if (/(year|annual|12)/.test(key)) return 365;
    if (/half/.test(key)) return 180;
    if (/quarter/.test(key)) return 90;
    if (/month/.test(key)) return 30;
    const days = /(\d{1,3})\s*days?/.exec(key);
    return days ? Number(days[1]) : 0;
}

/**
 * Reads every data row under the header with the chosen columns. Returns rows with their values
 * and any problems found in the row on its own (before plans and duplicates are considered).
 */
export function readImportRows(rows, headerIndex, columns, { date1904 = false } = {}) {
    const read = (row, key) => (columns[key] >= 0 ? row[columns[key]] : undefined);
    const result = [];
    for (let index = headerIndex + 1; index < rows.length; index += 1) {
        const row = rows[index] || [];
        if (isEmptyRow(row)) continue;
        const problems = [];
        const name = cleanMemberName(cellText(read(row, "name")));
        const nameIssue = memberNameIssue(name);
        if (nameIssue) problems.push(NAME_PROBLEMS[nameIssue]);
        const phone = importPhone(read(row, "phone"));
        if (phone.problem) problems.push(phone.problem);
        const start = importDate(read(row, "startDate"), { date1904 });
        if (start.problem) problems.push(`start date ${start.problem}`);
        const end = importDate(read(row, "endDate"), { date1904 });
        if (end.problem) problems.push(`end date ${end.problem}`);
        if (start.date && end.date && end.date < start.date) problems.push("end date is before the start date");
        const amount = importAmount(read(row, "amountPaid"));
        if (amount.problem) problems.push(amount.problem);
        const notes = cellText(read(row, "notes")).slice(0, 5000);
        result.push({
            rowNumber: index + 1,
            cells: row.map(cellText),
            name,
            phone: phone.phone,
            phoneText: cellText(read(row, "phone")),
            planName: cellText(read(row, "plan")),
            startDate: start.date,
            endDate: end.date,
            amountPaid: amount.amount,
            notes,
            problems
        });
    }
    return result;
}

/** Plan names in the file that are not one of the gym's active plans, with how many rows use them. */
export function unknownPlans(importRows, activePlans) {
    const known = new Set(activePlans.map((plan) => planKey(plan.name)));
    const counts = new Map();
    for (const row of importRows) {
        const key = planKey(row.planName);
        // A row without a plan but with dates or a payment needs a plan too.
        const needsPlan = key || row.startDate || row.endDate || row.amountPaid > 0;
        if (!needsPlan || (key && known.has(key))) continue;
        const entry = counts.get(key) || { key, name: row.planName || "", count: 0 };
        entry.count += 1;
        counts.set(key, entry);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
}

/**
 * Sorts the rows into what will be saved, what needs attention, and members already in the gym.
 * planChoices: { [planKey]: { action: "map", planId } | { action: "create", name, durationDays, price } | { action: "skip" } }
 * existingMembers: [{ id, name, phone }]; memberships: [{ member_id, start_date, end_date, status }]
 * duplicateMode: "skip" (leave existing members alone) or "update" (name, notes, and the plan
 * from the file when it does not overlap one they have).
 */
export function planImport(importRows, { activePlans = [], planChoices = {}, existingMembers = [], memberships = [], duplicateMode = "skip", today = indiaISODate() } = {}) {
    const plansByKey = new Map(activePlans.map((plan) => [planKey(plan.name), plan]));
    const existingByPhone = new Map(existingMembers.map((member) => [String(member.phone || "").replace(/\D/g, "").slice(-10), member]));
    const newPlans = [];
    const newPlanRefs = new Map();
    for (const [key, choice] of Object.entries(planChoices)) {
        if (choice?.action !== "create") continue;
        const ref = `new-${newPlans.length + 1}`;
        newPlans.push({ ref, name: String(choice.name || "").trim(), duration_days: Number(choice.durationDays), price: Number(choice.price) });
        newPlanRefs.set(key, { ref, durationDays: Number(choice.durationDays), name: String(choice.name || "").trim() });
    }
    const seenPhones = new Map();
    const ready = [];
    const problems = [];
    const duplicates = [];
    for (const row of importRows) {
        const reasons = [...row.problems];
        if (row.phone && seenPhones.has(row.phone)) reasons.push(`same phone as row ${seenPhones.get(row.phone)}`);
        if (row.phone && !seenPhones.has(row.phone)) seenPhones.set(row.phone, row.rowNumber);

        const key = planKey(row.planName);
        const needsPlan = Boolean(key || row.startDate || row.endDate || row.amountPaid > 0);
        let plan = null;
        if (needsPlan) {
            const choice = plansByKey.has(key) ? { action: "map", planId: plansByKey.get(key).id } : planChoices[key];
            if (!choice) reasons.push(key ? `plan "${row.planName}" is not one of your plans` : "dates or an amount paid but no plan");
            else if (choice.action === "skip") reasons.push(key ? `plan "${row.planName}" was set to be skipped` : "rows without a plan were set to be skipped");
            else if (choice.action === "map") {
                const mapped = activePlans.find((item) => item.id === choice.planId);
                if (mapped) plan = { id: mapped.id, name: mapped.name, durationDays: Number(mapped.duration_days) };
                else reasons.push(`plan "${row.planName}" is not one of your plans`);
            } else if (choice.action === "create") {
                const created = newPlanRefs.get(key);
                plan = { ref: created.ref, name: created.name, durationDays: created.durationDays };
            }
        }
        let startDate = row.startDate;
        let endDate = row.endDate;
        if (plan && !startDate && !endDate) reasons.push("plan needs a start date or an end date");
        if (plan && plan.durationDays > 0) {
            if (startDate && !endDate) endDate = addDays(startDate, plan.durationDays - 1);
            if (endDate && !startDate) startDate = addDays(endDate, -(plan.durationDays - 1));
        }

        const existing = row.phone ? existingByPhone.get(row.phone) : null;
        // Saved as they are, but shown in the preview so the owner can check them.
        const warnings = plan ? memberWarnings({ startDate, today }).warnings : [];
        const entry = { ...row, plan, startDate, endDate, existing: existing || null, reasons, warnings };
        if (reasons.length) { problems.push(entry); continue; }
        if (existing && duplicateMode !== "update") { duplicates.push(entry); continue; }
        if (existing && plan) {
            const overlap = memberships.find((membership) => membership.member_id === existing.id && membership.status !== "cancelled"
                && membership.start_date <= endDate && membership.end_date >= startDate);
            if (overlap) {
                entry.reasons = [`${existing.name} already has a plan from ${overlap.start_date} to ${overlap.end_date}`];
                problems.push(entry);
                continue;
            }
        }
        ready.push(entry);
    }
    const usedRefs = new Set(ready.map((row) => row.plan?.ref).filter(Boolean));
    const payload = {
        update_existing: duplicateMode === "update",
        new_plans: newPlans.filter((plan) => usedRefs.has(plan.ref)),
        rows: ready.map((row) => ({
            row: row.rowNumber,
            full_name: row.name,
            phone: row.phone,
            notes: row.notes || null,
            plan: row.plan ? (row.plan.ref ? { ref: row.plan.ref } : { id: row.plan.id }) : null,
            start_date: row.plan ? row.startDate : null,
            end_date: row.plan ? row.endDate : null,
            amount_paid: row.plan && row.amountPaid > 0 ? row.amountPaid : null
        }))
    };
    return {
        ready,
        problems,
        duplicates,
        // Rows whose phone already belongs to a member, whatever happens to them: the skip or
        // update choice stays on screen even when every match ends up needing attention.
        existingMatches: [...ready, ...problems, ...duplicates].filter((row) => row.existing).length,
        newMembers: ready.filter((row) => !row.existing).length,
        updates: ready.filter((row) => row.existing).length,
        payload
    };
}

/** Skipped rows with the owner's own columns and the reason, for a CSV they can fix and re-import. */
export function skippedRows(plan, headers) {
    const seen = new Map();
    const columnNames = headers.map((header, index) => {
        const name = String(header || "").trim() || `Column ${index + 1}`;
        const count = (seen.get(name) || 0) + 1;
        seen.set(name, count);
        return count > 1 ? `${name} (${count})` : name;
    });
    const rows = [
        ...plan.problems.map((row) => ({ row, reason: row.reasons.join("; ") })),
        ...plan.duplicates.map((row) => ({ row, reason: `already a member: ${row.existing.name}` }))
    ].sort((a, b) => a.row.rowNumber - b.row.rowNumber);
    return rows.map(({ row, reason }) => ({
        "Row in file": row.rowNumber,
        ...Object.fromEntries(columnNames.map((name, index) => [name, row.cells[index] ?? ""])),
        "Why it was skipped": reason
    }));
}
