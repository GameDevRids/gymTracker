const editableFields = new Set(["name", "description", "duration_days", "price", "is_active"]);
const allowedStatuses = new Set(["active", "inactive"]);

export function validatePlanId(request, response, next) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id || "")) {
        return response.status(400).json({ status: "error", message: "Plan ID must be a valid UUID." });
    }
    next();
}

export function validatePlanListQuery(request, response, next) {
    const { page = "1", limit = "20", status, search } = request.query;
    const pageNumber = Number(page);
    const limitNumber = Number(limit);
    if (!/^\d+$/.test(String(page)) || !Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        return response.status(400).json({ status: "error", message: "Page must be a positive integer." });
    }
    if (!/^\d+$/.test(String(limit)) || !Number.isSafeInteger(limitNumber) || limitNumber < 1 || limitNumber > 100) {
        return response.status(400).json({ status: "error", message: "Limit must be an integer between 1 and 100." });
    }
    if (!Number.isSafeInteger((pageNumber - 1) * limitNumber)) {
        return response.status(400).json({ status: "error", message: "Page and limit exceed the supported range." });
    }
    if (status !== undefined && !allowedStatuses.has(status)) {
        return response.status(400).json({ status: "error", message: "Status must be active or inactive." });
    }
    if (search !== undefined && (typeof search !== "string" || search.length > 100)) {
        return response.status(400).json({ status: "error", message: "Search must be 100 characters or fewer." });
    }
    request.planListQuery = {
        page: pageNumber,
        limit: limitNumber,
        status,
        search: typeof search === "string" ? search.trim() : ""
    };
    next();
}

export function validatePlanPayload(mode) {
    return (request, response, next) => {
        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return response.status(400).json({ status: "error", message: "Request body must be a JSON object." });
        }

        const keys = Object.keys(body);
        const unknownField = keys.find((key) => !editableFields.has(key));
        if (unknownField) {
            return response.status(400).json({ status: "error", message: `Unsupported or protected field: ${unknownField}.` });
        }
        if (mode === "update" && keys.length === 0) {
            return response.status(400).json({ status: "error", message: "Provide at least one field to update." });
        }

        const plan = {};
        for (const [field, value] of Object.entries(body)) {
            if (field === "name") {
                if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
                    return response.status(400).json({ status: "error", message: "Plan name must be between 1 and 120 characters." });
                }
                plan.name = value.trim();
            } else if (field === "description") {
                if (value !== null && (typeof value !== "string" || value.length > 2000)) {
                    return response.status(400).json({ status: "error", message: "Plan description must be 2000 characters or fewer." });
                }
                plan.description = typeof value === "string" ? (value.trim() || null) : null;
            } else if (field === "duration_days") {
                if (!Number.isInteger(value) || value <= 0) {
                    return response.status(400).json({ status: "error", message: "Duration must be a positive whole number of days." });
                }
                plan.duration_days = value;
            } else if (field === "price") {
                if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
                    return response.status(400).json({ status: "error", message: "Price must be a valid non-negative number." });
                }
                plan.price = value;
            } else if (field === "is_active") {
                if (typeof value !== "boolean") {
                    return response.status(400).json({ status: "error", message: "Plan status must be active or inactive." });
                }
                plan.is_active = value;
            }
        }

        if (mode === "create") {
            for (const field of ["name", "duration_days", "price"]) {
                if (plan[field] === undefined) {
                    return response.status(400).json({ status: "error", message: `${field} is required.` });
                }
            }
        }

        request.validatedPlan = plan;
        next();
    };
}
