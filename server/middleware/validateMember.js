import { z } from "zod";

const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const dateSchema = z.string().trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
    });
const emptyToNull = (schema) => z.preprocess((value) => value === null || value === "" ? null : value, schema);
const indianPhone = z.preprocess(
    (value) => typeof value === "string" && /^\+91[6-9][0-9]{9}$/.test(value) ? value.slice(3) : value,
    z.string().regex(/^[6-9][0-9]{9}$/)
);
const memberValueSchemas = {
    member_code: z.string().trim().min(1).max(64),
    full_name: z.string().trim().min(1).max(200),
    phone: indianPhone,
    email: emptyToNull(z.string().trim().max(254).email()).nullable(),
    gender: emptyToNull(z.string().trim().max(32)).nullable(),
    date_of_birth: emptyToNull(dateSchema).nullable(),
    status: z.string().trim().pipe(z.enum(["active", "suspended"])),
    notes: emptyToNull(z.string().max(5000)).nullable()
};
const editableFields = new Set(Object.keys(memberValueSchemas));
const memberObjectSchema = z.record(z.string(), z.unknown());

function memberFieldError(field) {
    if (field === "full_name") return "Full name must be between 1 and 200 characters.";
    if (field === "phone") return "Enter a valid Indian phone number (10 digits starting with 6–9, optionally with +91).";
    if (field === "member_code") return "Member code must be between 1 and 64 characters.";
    if (field === "email") return "Enter a valid email address.";
    if (field === "gender") return "Gender must be 32 characters or fewer.";
    if (field === "notes") return "Notes must be 5000 characters or fewer.";
    if (field === "date_of_birth") return `${field} must be a valid YYYY-MM-DD date.`;
    return "Status must be active or suspended.";
}

function sendValidationError(response, message) {
    return response.status(400).json({ status: "error", message });
}

export function validateMemberPayload(mode) {
    return (request, response, next) => {
        const parsedObject = memberObjectSchema.safeParse(request.body);
        if (!parsedObject.success || Array.isArray(request.body)) {
            return sendValidationError(response, "Request body must be a JSON object.");
        }

        const body = parsedObject.data;
        const keys = Object.keys(body);
        if (keys.some((key) => key === "membership_start_date" || key === "membership_end_date")) {
            return sendValidationError(response, "Membership dates must be managed through the membership assignment system.");
        }
        const unknownField = keys.find((key) => !editableFields.has(key));
        if (unknownField) {
            return sendValidationError(response, `Unsupported or protected field: ${unknownField}.`);
        }
        if (mode === "update" && keys.length === 0) {
            return sendValidationError(response, "Provide at least one field to update.");
        }

        const member = {};
        for (const [field, value] of Object.entries(body)) {
            const result = memberValueSchemas[field].safeParse(value);
            if (!result.success) return sendValidationError(response, memberFieldError(field));
            member[field] = result.data;
        }

        if (mode === "create") {
            for (const field of ["full_name", "phone"]) {
                if (!member[field]) return sendValidationError(response, `${field} is required.`);
            }
        }

        request.validatedMember = member;
        next();
    };
}

export function validateMemberId(request, response, next) {
    const memberId = request.params.memberId ?? request.params.id;
    if (!uuidSchema.safeParse(memberId).success) {
        return sendValidationError(response, "Member ID must be a valid UUID.");
    }
    next();
}

const memberListQuerySchema = z.object({
    page: z.string().regex(/^\d+$/).optional().default("1"),
    limit: z.string().regex(/^\d+$/).optional().default("25"),
    status: z.enum(["active", "suspended"]).optional(),
    search: z.string().max(100).optional(),
    include_archived: z.enum(["true", "false"]).optional().default("false")
});

export function validateMemberListQuery(request, response, next) {
    const parsed = memberListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const message = issue.path[0] === "status"
            ? "Status must be active or suspended."
            : issue.path[0] === "search"
                ? "Search must be 100 characters or fewer."
                : issue.path[0] === "limit"
                    ? "Limit must be an integer between 1 and 100."
                    : "Page must be a positive integer.";
        return sendValidationError(response, message);
    }

    const page = Number(parsed.data.page);
    const limit = Number(parsed.data.limit);
    if (!Number.isSafeInteger(page) || page < 1) return sendValidationError(response, "Page must be a positive integer.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return sendValidationError(response, "Limit must be an integer between 1 and 100.");
    }
    if (!Number.isSafeInteger((page - 1) * limit)) {
        return sendValidationError(response, "Page and limit exceed the supported range.");
    }

    request.memberListQuery = {
        page,
        limit,
        status: parsed.data.status,
        search: parsed.data.search?.trim() || "",
        includeArchived: parsed.data.include_archived === "true"
    };
    next();
}
