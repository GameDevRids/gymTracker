import { z } from "zod";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
const paymentSchema = z.object({
    member_id: uuid,
    membership_id: uuid.nullable().optional(),
    amount: z.coerce.number().finite().positive().max(9999999999.99),
    method: z.enum(["cash", "upi", "card", "other"]),
    paid_on: date,
    note: z.string().trim().max(1000).nullable().optional()
}).strict();

function invalid(response, message) {
    return response.status(400).json({ status: "error", message });
}

export function validatePaymentPayload(request, response, next) {
    const parsed = paymentSchema.safeParse(request.body);
    if (!parsed.success) return invalid(response, "Provide a valid member, positive amount, payment method, date, and optional note.");
    request.validatedPayment = parsed.data;
    next();
}

export function validatePaymentId(request, response, next) {
    if (!uuid.safeParse(request.params.id || "").success) return invalid(response, "Payment ID must be a valid UUID.");
    next();
}
