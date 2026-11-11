import { z } from "zod";
import { UTR_PATTERN } from "../../assets/js/upi.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
// The receipt number is assigned by the database, so it is not accepted here.
const paymentSchema = z.object({
    member_id: uuid,
    membership_id: uuid.nullable().optional(),
    amount: z.coerce.number().finite().positive().max(9999999999.99),
    method: z.enum(["cash", "upi", "card", "other"]),
    paid_on: date,
    note: z.string().trim().max(1000).nullable().optional(),
    upi_reference: z.preprocess(
        (value) => typeof value === "string" ? (value.replace(/\s/g, "") || null) : value,
        z.string().regex(UTR_PATTERN).nullable().optional()
    )
}).strict();

function invalid(response, message) {
    return response.status(400).json({ status: "error", message });
}

export function validatePaymentPayload(request, response, next) {
    const parsed = paymentSchema.safeParse(request.body);
    if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        if (field === "amount") return invalid(response, "The amount must be greater than zero.");
        if (field === "upi_reference") return invalid(response, "The UPI reference (UTR) must be 12 digits.");
        return invalid(response, "Provide a valid member, positive amount, payment method, date, and optional note.");
    }
    if (parsed.data.upi_reference && parsed.data.method !== "upi") {
        return invalid(response, "A UPI reference (UTR) can only be recorded on a UPI payment.");
    }
    request.validatedPayment = parsed.data;
    next();
}

export function validatePaymentId(request, response, next) {
    if (!uuid.safeParse(request.params.id || "").success) return invalid(response, "Payment ID must be a valid UUID.");
    next();
}

export function validatePaymentListQuery(request, response, next) {
    const page = Number(request.query.page ?? 1);
    const limit = Number(request.query.limit ?? 50);
    if (!Number.isSafeInteger(page) || page < 1) return invalid(response, "Page must be a positive integer.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return invalid(response, "Limit must be an integer between 1 and 100.");
    request.paymentListQuery = { page, limit };
    next();
}
