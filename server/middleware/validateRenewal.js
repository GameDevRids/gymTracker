import { z } from "zod";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
const money = z.number().finite().min(0).max(10000000).transform((value) => Math.round(value * 100) / 100);

// What the renew sheet sends. The database works out the start date; start_date is only sent when
// the owner chose another one, and expected_start lets it refuse when the dates moved since the
// sheet opened. discount_reason "welcome_back" marks the quick discount for lapsed and old members.
const renewSchema = z.object({
    idempotency_key: uuid,
    plan_id: uuid,
    start_date: date.optional(),
    expected_start: date.optional(),
    discount_reason: z.enum(["welcome_back"]).optional(),
    total_fees: money.optional(),
    amount_paid: money.optional(),
    method: z.enum(["cash", "upi", "card", "other"]).optional(),
    upi_reference: z.string().trim().regex(/^[0-9]{12}$/).nullable().optional().or(z.literal("").transform(() => null))
}).strict();

// Settings › Renewals and grace (owner only).
const renewalSettingsSchema = z.object({
    expiry_grace_days: z.number().int().min(0).max(60),
    welcome_back_discount_type: z.enum(["amount", "percent"]),
    welcome_back_discount_value: z.number().finite().min(0).max(10000000),
    lapsed_list_days: z.number().int().min(7).max(365)
}).partial().strict();

export function validateRenewalSettings(request, response, next) {
    const parsed = renewalSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        const messages = {
            expiry_grace_days: "Grace must be a whole number of days from 0 to 60.",
            welcome_back_discount_type: "Choose an amount or a percent for the welcome-back discount.",
            welcome_back_discount_value: "Enter the welcome-back discount (0 or more).",
            lapsed_list_days: "Keep lapsed members on the list for 7 to 365 days."
        };
        return response.status(400).json({ status: "error", message: messages[field] || "Send only the renewal settings." });
    }
    const values = parsed.data;
    if (values.welcome_back_discount_type === "percent" && values.welcome_back_discount_value > 100) {
        return response.status(400).json({ status: "error", message: "A percent discount can be at most 100." });
    }
    if (!Object.keys(values).length) return response.status(400).json({ status: "error", message: "Nothing to change." });
    request.renewalSettings = values;
    next();
}

export function validateRenewPayload(request, response, next) {
    const parsed = renewSchema.safeParse(request.body);
    if (!parsed.success) {
        return response.status(400).json({ status: "error", message: "Choose a plan and check the fee, the amount paid and the UPI reference (12 digits).", code: "invalid" });
    }
    request.renewalPayload = parsed.data;
    next();
}
