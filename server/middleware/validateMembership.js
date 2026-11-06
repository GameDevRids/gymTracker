import { z } from "zod";

const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const dateSchema = z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
    });
const assignmentSchema = z.object({
    plan_id: uuidSchema,
    start_date: dateSchema
}).strict();
const membershipListQuerySchema = z.object({
    page: z.string().regex(/^\d+$/).optional().default("1"),
    limit: z.string().regex(/^\d+$/).optional().default("25")
});
const expiringQuerySchema = z.object({
    days: z.enum(["3", "7", "15", "30"]).optional().default("7")
});

function sendValidationError(response, message) {
    return response.status(400).json({ status: "error", message });
}

function parsePagination(request, response, schema) {
    const parsed = schema.safeParse(request.query);
    if (!parsed.success) {
        const field = parsed.error.issues[0].path[0];
        return sendValidationError(response, field === "limit"
            ? "Limit must be an integer between 1 and 100."
            : "Page must be a positive integer.");
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
    return { page, limit };
}

export function validateMembershipId(request, response, next) {
    if (!uuidSchema.safeParse(request.params.id || "").success) {
        return sendValidationError(response, "Membership ID must be a valid UUID.");
    }
    next();
}

export function validateAssignmentPayload(request, response, next) {
    const parsed = assignmentSchema.safeParse(request.body);
    if (!parsed.success) {
        if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
            return sendValidationError(response, "Request body must be a JSON object.");
        }
        if (Object.keys(request.body).some((field) => !["plan_id", "start_date"].includes(field))) {
            return sendValidationError(response, "Only plan_id and start_date may be provided.");
        }
        if (!uuidSchema.safeParse(request.body.plan_id).success) {
            return sendValidationError(response, "Plan ID must be a valid UUID.");
        }
        return sendValidationError(response, "Start date must be a valid YYYY-MM-DD date.");
    }
    request.validatedAssignment = parsed.data;
    next();
}

export function validateMembershipListQuery(request, response, next) {
    const pagination = parsePagination(request, response, membershipListQuerySchema);
    if (!pagination) return;
    request.membershipListQuery = pagination;
    next();
}

export function validateExpiringMembershipQuery(request, response, next) {
    const parsed = expiringQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(response, "Days must be one of 3, 7, 15, or 30.");
    request.expiringMembershipQuery = { days: Number(parsed.data.days) };
    next();
}
