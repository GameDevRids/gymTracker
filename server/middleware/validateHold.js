import { z } from "zod";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);

// What the "Put plan on hold" sheet sends. The gym, the staff member and the plan come from the
// sign-in and the database, never from here. planned_return_on null/absent = "Until they come back".
// method and upi_reference only matter when the gym charges a hold fee.
const holdSchema = z.object({
    idempotency_key: uuid,
    starts_on: date,
    planned_return_on: date.nullable().optional(),
    method: z.enum(["cash", "upi", "card", "other"]).optional(),
    upi_reference: z.string().trim().regex(/^[0-9]{12}$/).nullable().optional().or(z.literal("").transform(() => null))
}).strict();

export function validateHoldPayload(request, response, next) {
    const parsed = holdSchema.safeParse(request.body);
    if (!parsed.success) {
        return response.status(400).json({ status: "error", message: "Check the start date, the return date and the UPI reference (12 digits).", code: "invalid" });
    }
    request.holdPayload = parsed.data;
    next();
}

export function validateHoldId(request, response, next) {
    if (!uuid.safeParse(request.params.holdId).success) {
        return response.status(400).json({ status: "error", message: "Hold ID must be a valid UUID." });
    }
    next();
}
