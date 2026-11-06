function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || "");
}

function isValidDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateMembershipId(request, response, next) {
    if (!isUuid(request.params.id)) {
        return response.status(400).json({ status: "error", message: "Membership ID must be a valid UUID." });
    }
    next();
}

export function validateAssignmentPayload(request, response, next) {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return response.status(400).json({ status: "error", message: "Request body must be a JSON object." });
    }
    const fields = Object.keys(body);
    if (fields.some((field) => !["plan_id", "start_date"].includes(field))) {
        return response.status(400).json({ status: "error", message: "Only plan_id and start_date may be provided." });
    }
    if (!isUuid(body.plan_id)) {
        return response.status(400).json({ status: "error", message: "Plan ID must be a valid UUID." });
    }
    if (!isValidDate(body.start_date)) {
        return response.status(400).json({ status: "error", message: "Start date must be a valid YYYY-MM-DD date." });
    }
    request.validatedAssignment = { plan_id: body.plan_id, start_date: body.start_date };
    next();
}

export function validateMembershipListQuery(request, response, next) {
    const { page = "1", limit = "100" } = request.query;
    const pageNumber = Number(page);
    const limitNumber = Number(limit);
    if (!/^\d+$/.test(String(page)) || !Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        return response.status(400).json({ status: "error", message: "Page must be a positive integer." });
    }
    if (!/^\d+$/.test(String(limit)) || !Number.isSafeInteger(limitNumber) || limitNumber < 1 || limitNumber > 100) {
        return response.status(400).json({ status: "error", message: "Limit must be an integer between 1 and 100." });
    }
    request.membershipListQuery = { page: pageNumber, limit: limitNumber };
    next();
}
