import { z } from "zod";
import { memberNameIssue } from "../../assets/js/utils.js";

// The browser has already read the owner's spreadsheet and shown a preview. Every row is checked
// again here, and once more in the database function that saves the import (migration 016).

const MAX_ROWS = 2000;
const NAME_MESSAGES = {
    missing: "the name is missing",
    email: "the name looks like an email address",
    "too-long": "the name is too long",
    invalid: "the name must use letters"
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= "1990-01-01" && value <= "2100-12-31";
});

const planRef = z.union([
    z.object({ id: z.string().uuid() }).strict(),
    z.object({ ref: z.string().min(1).max(40) }).strict()
]);

const importSchema = z.object({
    update_existing: z.boolean(),
    new_plans: z.array(z.object({
        ref: z.string().min(1).max(40),
        name: z.string().trim().min(1).max(120),
        duration_days: z.number().int().min(1).max(3650),
        price: z.number().min(0).max(10000000)
    }).strict()).max(50).default([]),
    rows: z.array(z.object({
        row: z.number().int().min(1).max(1000000),
        full_name: z.string().max(200),
        phone: z.string().regex(/^[6-9]\d{9}$/),
        notes: z.string().max(5000).nullable().optional(),
        plan: planRef.nullable().optional(),
        start_date: isoDate.nullable().optional(),
        end_date: isoDate.nullable().optional(),
        amount_paid: z.number().min(0).max(10000000).nullable().optional()
    }).strict()).min(1).max(MAX_ROWS)
}).strict();

function rowProblem(row, refs) {
    const nameIssue = memberNameIssue(row.full_name);
    if (nameIssue) return NAME_MESSAGES[nameIssue];
    if (row.plan?.ref && !refs.has(row.plan.ref)) return "the new plan is missing";
    if (row.plan && !row.start_date && !row.end_date) return "the plan needs a start date or an end date";
    if (row.start_date && row.end_date && row.end_date < row.start_date) return "the end date is before the start date";
    if (!row.plan && (row.amount_paid || 0) > 0) return "an amount paid needs a plan";
    return "";
}

export function validateImportPayload(request, response, next) {
    const parsed = importSchema.safeParse(request.body);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const rowIndex = issue?.path?.[0] === "rows" && Number.isInteger(issue.path[1]) ? issue.path[1] : -1;
        const rowNumber = rowIndex >= 0 ? request.body?.rows?.[rowIndex]?.row : null;
        const field = issue?.path?.[2];
        const message = rowNumber
            ? `Row ${rowNumber}: ${field === "phone" ? "the phone number is not a 10-digit Indian mobile number" : `check the ${String(field || "values").replace(/_/g, " ")}`}.`
            : issue?.path?.[0] === "rows" && issue.code === "too_big" ? `Import at most ${MAX_ROWS} members at a time.`
                : issue?.path?.[0] === "rows" && issue.code === "too_small" ? "There are no members to import."
                    : "The import could not be read. Go back to the preview and try again.";
        return response.status(400).json({ status: "error", message });
    }
    const refs = new Set(parsed.data.new_plans.map((plan) => plan.ref));
    const phones = new Map();
    for (const row of parsed.data.rows) {
        const problem = rowProblem(row, refs);
        if (problem) return response.status(400).json({ status: "error", message: `Row ${row.row}: ${problem}.` });
        if (phones.has(row.phone)) return response.status(400).json({ status: "error", message: `Row ${row.row}: this phone number is also on row ${phones.get(row.phone)}.` });
        phones.set(row.phone, row.row);
    }
    request.importPayload = {
        ...parsed.data,
        rows: parsed.data.rows.map((row) => ({ ...row, full_name: row.full_name.trim().replace(/\s+/g, " "), notes: row.notes?.trim() || null }))
    };
    next();
}
