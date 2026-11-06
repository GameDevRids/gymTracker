import { z } from "zod";

const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const planValueSchemas = {
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).nullable().transform((value) => value?.trim() || null),
    duration_days: z.number().int().positive(),
    price: z.number().finite().nonnegative(),
    is_active: z.boolean()
};
const editableFields = new Set(Object.keys(planValueSchemas));
const planObjectSchema = z.record(z.string(), z.unknown());

function sendValidationError(response, message) {
    return response.status(400).json({ status: "error", message });
}

function planFieldError(field) {
    if (field === "name") return "Plan name must be between 1 and 120 characters.";
    if (field === "description") return "Plan description must be 2000 characters or fewer.";
    if (field === "duration_days") return "Duration must be a positive whole number of days.";
    if (field === "price") return "Price must be a valid non-negative number.";
    return "Plan status must be active or inactive.";
}

const planListQuerySchema = z.object({
    page: z.string().regex(/^\d+$/).optional().default("1"),
    limit: z.string().regex(/^\d+$/).optional().default("25"),
    status: z.enum(["active", "inactive"]).optional(),
    search: z.string().max(100).optional()
});

export function validatePlanId(request, response, next) {
    if (!uuidSchema.safeParse(request.params.id || "").success) {
        return sendValidationError(response, "Plan ID must be a valid UUID.");
    }
    next();
}

export function validatePlanListQuery(request, response, next) {
    const parsed = planListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const message = issue.path[0] === "status"
            ? "Status must be active or inactive."
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
    request.planListQuery = { page, limit, status: parsed.data.status, search: parsed.data.search?.trim() || "" };
    next();
}

export function validatePlanPayload(mode) {
    return (request, response, next) => {
        const parsedObject = planObjectSchema.safeParse(request.body);
        if (!parsedObject.success || Array.isArray(request.body)) {
            return sendValidationError(response, "Request body must be a JSON object.");
        }

        const body = parsedObject.data;
        const keys = Object.keys(body);
        const unknownField = keys.find((key) => !editableFields.has(key));
        if (unknownField) {
            return sendValidationError(response, `Unsupported or protected field: ${unknownField}.`);
        }
        if (mode === "update" && keys.length === 0) {
            return sendValidationError(response, "Provide at least one field to update.");
        }

        const plan = {};
        for (const [field, value] of Object.entries(body)) {
            const result = planValueSchemas[field].safeParse(value);
            if (!result.success) return sendValidationError(response, planFieldError(field));
            plan[field] = result.data;
        }
        if (mode === "create") {
            for (const field of ["name", "duration_days", "price"]) {
                if (plan[field] === undefined) return sendValidationError(response, `${field} is required.`);
            }
        }
        request.validatedPlan = plan;
        next();
    };
}
