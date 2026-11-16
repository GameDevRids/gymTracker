import { z } from "zod";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
const money = z.number().finite().min(0).max(10000000).transform((value) => Math.round(value * 100) / 100);

// What the renew sheet sends. The start date is not here: the database works it out, and
// expected_start only lets it refuse when the dates moved since the sheet opened.
const renewSchema = z.object({
    idempotency_key: uuid,
    plan_id: uuid,
    backdate: z.boolean().optional(),
    expected_start: date.optional(),
    total_fees: money.optional(),
    amount_paid: money.optional(),
    method: z.enum(["cash", "upi", "card", "other"]).optional(),
    upi_reference: z.string().trim().regex(/^[0-9]{12}$/).nullable().optional().or(z.literal("").transform(() => null))
}).strict();

export function validateRenewPayload(request, response, next) {
    const parsed = renewSchema.safeParse(request.body);
    if (!parsed.success) {
        return response.status(400).json({ status: "error", message: "Choose a plan and check the fee, the amount paid and the UPI reference (12 digits).", code: "invalid" });
    }
    request.renewalPayload = parsed.data;
    next();
}
