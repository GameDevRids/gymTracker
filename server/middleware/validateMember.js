const editableFields = new Set([
    "member_code",
    "full_name",
    "phone",
    "email",
    "gender",
    "date_of_birth",
    "status",
    "notes"
]);

const optionalTextFields = new Set(["email", "gender", "date_of_birth", "notes"]);
const allowedStatuses = new Set(["active", "suspended"]);

function isValidDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidPhone(value) {
    return typeof value === "string" && /^[0-9]{10}$/.test(value);
}

export function validateMemberPayload(mode) {
    return (request, response, next) => {
        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return response.status(400).json({ status: "error", message: "Request body must be a JSON object." });
        }

        const keys = Object.keys(body);
        if (keys.some((key) => key === "membership_start_date" || key === "membership_end_date")) {
            return response.status(400).json({
                status: "error",
                message: "Membership dates must be managed through the membership assignment system."
            });
        }
        const unknownFields = keys.filter((key) => !editableFields.has(key));
        if (unknownFields.length) {
            return response.status(400).json({
                status: "error",
                message: `Unsupported or protected field: ${unknownFields[0]}.`
            });
        }
        if (mode === "update" && keys.length === 0) {
            return response.status(400).json({ status: "error", message: "Provide at least one field to update." });
        }

        const member = {};
        for (const [field, value] of Object.entries(body)) {
            if (optionalTextFields.has(field) && (value === null || value === "")) {
                member[field] = null;
                continue;
            }
            if (typeof value !== "string") {
                return response.status(400).json({ status: "error", message: `${field} must be a string.` });
            }

            const trimmed = value.trim();
            if (field === "full_name") {
                if (!trimmed || trimmed.length > 200) {
                    return response.status(400).json({ status: "error", message: "Full name must be between 1 and 200 characters." });
                }
                member[field] = trimmed;
            } else if (field === "phone") {
                if (!isValidPhone(value)) {
                    return response.status(400).json({ status: "error", message: "Phone number must contain exactly 10 digits." });
                }
                member[field] = value;
            } else if (field === "member_code") {
                if (!trimmed || trimmed.length > 64) {
                    return response.status(400).json({ status: "error", message: "Member code must be between 1 and 64 characters." });
                }
                member[field] = trimmed;
            } else if (field === "email") {
                if (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
                    return response.status(400).json({ status: "error", message: "Enter a valid email address." });
                }
                member[field] = trimmed;
            } else if (field === "gender") {
                if (trimmed.length > 32) {
                    return response.status(400).json({ status: "error", message: "Gender must be 32 characters or fewer." });
                }
                member[field] = trimmed;
            } else if (field === "notes") {
                if (value.length > 5000) {
                    return response.status(400).json({ status: "error", message: "Notes must be 5000 characters or fewer." });
                }
                member[field] = value;
            } else if (field === "date_of_birth") {
                if (!isValidDate(trimmed)) {
                    return response.status(400).json({ status: "error", message: `${field} must be a valid YYYY-MM-DD date.` });
                }
                member[field] = trimmed;
            } else if (field === "status") {
                if (!allowedStatuses.has(trimmed)) {
                    return response.status(400).json({ status: "error", message: "Status must be active or suspended." });
                }
                member[field] = trimmed;
            }
        }

        if (mode === "create") {
            for (const field of ["full_name", "phone"]) {
                if (!member[field]) {
                    return response.status(400).json({ status: "error", message: `${field} is required.` });
                }
            }
        }

        request.validatedMember = member;
        next();
    };
}

export function validateMemberId(request, response, next) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id || "")) {
        return response.status(400).json({ status: "error", message: "Member ID must be a valid UUID." });
    }
    next();
}

export function validateMemberListQuery(request, response, next) {
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
        return response.status(400).json({ status: "error", message: "Status must be active or suspended." });
    }
    if (search !== undefined && (typeof search !== "string" || search.length > 100)) {
        return response.status(400).json({ status: "error", message: "Search must be 100 characters or fewer." });
    }

    request.memberListQuery = {
        page: pageNumber,
        limit: limitNumber,
        status,
        search: typeof search === "string" ? search.trim() : ""
    };
    next();
}
