import { cleanMemberName, isValidIndianPhone, memberNameIssue, normalizeIndianPhone } from "../utils.js";

const NAME_IMPORT_ISSUES = {
    missing: "name is required",
    email: "name looks like an email address",
    "too-long": "name is too long",
    invalid: "name must use letters only"
};

// CSV import logic kept free of DOM and global state so it can be tested in Node.
// Headers arrive normalized by parseCSV: lower case with spaces, "_" and "-" removed.

const pick = (data, keys) => {
    for (const key of keys) {
        const value = String(data?.[key] ?? "").trim();
        if (value) return value;
    }
    return "";
};

const isISODate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime())
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

/** Ten-digit key used to detect duplicate phone numbers, or "" when not recognisable. */
export function importPhoneKey(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
    if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
    return digits.length === 10 ? digits : "";
}

export function readImportRow({ rowNumber, data }) {
    return {
        rowNumber,
        data,
        name: cleanMemberName(pick(data, ["name", "fullname", "membername"])),
        phone: pick(data, ["phone", "phonenumber", "mobile", "mobilenumber"]),
        email: pick(data, ["email", "emailaddress"]),
        dob: pick(data, ["dob", "dateofbirth"]),
        gender: pick(data, ["gender"]),
        planName: pick(data, ["plan", "membershipplan", "planname"]),
        startDate: pick(data, ["startdate", "joinedat", "joiningdate"]),
        expiryDate: pick(data, ["expirydate"])
    };
}

/**
 * Checks parsed CSV rows against the gym's existing member phones and active plans.
 * Returns valid rows first, then rows with issues, each carrying an `issues` array.
 */
export function validateImportRows(parsedRows, { existingPhones = [], activePlans = [] } = {}) {
    const seen = new Set(existingPhones.map(importPhoneKey).filter(Boolean));
    const planNames = new Set(activePlans.map((plan) => String(plan.name || "").trim().toLowerCase()));
    const valid = [];
    const invalid = [];
    for (const parsed of parsedRows) {
        const row = readImportRow(parsed);
        const issues = [];
        const phoneKey = importPhoneKey(row.phone);
        const nameIssue = memberNameIssue(row.name);
        if (nameIssue) issues.push(NAME_IMPORT_ISSUES[nameIssue]);
        if (!isValidIndianPhone(row.phone)) issues.push("valid Indian mobile number is required");
        else if (seen.has(phoneKey)) issues.push("duplicate phone number");
        if (phoneKey) seen.add(phoneKey);
        if (row.planName && !planNames.has(row.planName.toLowerCase())) issues.push("unknown membership plan");
        if (row.startDate && !isISODate(row.startDate)) issues.push("start date must use YYYY-MM-DD");
        if (row.expiryDate && !isISODate(row.expiryDate)) issues.push("expiry date must use YYYY-MM-DD");
        if (row.startDate && row.expiryDate && isISODate(row.startDate) && isISODate(row.expiryDate) && row.expiryDate < row.startDate) {
            issues.push("expiry date precedes start date");
        }
        (issues.length ? invalid : valid).push({ ...row, issues });
    }
    return { valid, invalid, rows: [...valid, ...invalid] };
}

/**
 * Creates each valid row through the API, one at a time, collecting per-row errors.
 * Rows without a plan are created unassigned rather than given an arbitrary plan.
 */
export async function importMembers(rows, { plans = [], createMember, assignPlan, onProgress = () => {}, today }) {
    const errors = [];
    let imported = 0;
    let withoutPlan = 0;
    for (const [index, row] of rows.entries()) {
        onProgress({ current: index + 1, total: rows.length, row });
        const plan = row.planName
            ? plans.find((item) => String(item.name || "").trim().toLowerCase() === row.planName.toLowerCase())
            : null;
        if (row.planName && !plan) {
            errors.push({ rowNumber: row.rowNumber, message: `Active membership plan "${row.planName}" was not found.` });
            continue;
        }
        let member;
        try {
            member = await createMember({
                name: row.name,
                phone: normalizeIndianPhone(row.phone),
                email: row.email,
                dob: row.dob,
                gender: row.gender,
                status: "active",
                notes: "Imported from CSV"
            });
            if (!member?.id) throw new Error("The member was not returned by the API.");
        } catch (error) {
            errors.push({ rowNumber: row.rowNumber, message: error?.message || "The member could not be created." });
            continue;
        }
        imported += 1;
        if (!plan) {
            withoutPlan += 1;
            continue;
        }
        try {
            await assignPlan(member.id, plan.id, row.startDate || today, Number(plan.price));
        } catch (error) {
            errors.push({
                rowNumber: row.rowNumber,
                message: `Member was created, but the plan was not assigned: ${String(error?.message || "assignment failed").replace(/\.+$/, "")}. Assign it from the member's profile.`
            });
        }
    }
    return { imported, withoutPlan, errors };
}

/** Reads every page of the members list and returns all phone numbers. */
export async function fetchAllMemberPhones(fetchPage, limit = 100) {
    const phones = [];
    for (let page = 1, totalPages = 1; page <= totalPages; page += 1) {
        const response = await fetchPage({ page, limit });
        const members = response?.data?.members;
        if (!Array.isArray(members)) throw new Error("The members API returned an unexpected response.");
        phones.push(...members.map((member) => member.phone).filter(Boolean));
        const total = response?.data?.pagination?.total ?? response?.total;
        totalPages = response?.data?.pagination?.totalPages ?? (Number.isFinite(total) ? Math.ceil(total / limit) : 1);
    }
    return phones;
}
