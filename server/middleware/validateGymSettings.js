import { z } from "zod";
import { upiIdProblem } from "../../assets/js/upi.js";

const optionalText = (max) => z.preprocess(
    (value) => typeof value === "string" ? (value.trim() || null) : value,
    z.string().max(max).nullable().optional()
);

const settingsSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.preprocess(
        (value) => typeof value === "string" ? (value.trim() || null) : value,
        z.string().regex(/^\+?[0-9 ()-]{6,20}$/).refine((value) => {
            const digits = value.replace(/\D/g, "").length;
            return digits >= 10 && digits <= 15;
        }).nullable().optional()
    ),
    address: optionalText(300),
    upi_id: optionalText(320),
    upi_payee_name: optionalText(100)
}).strict();

const fieldMessages = {
    name: "Gym name is required (up to 120 characters).",
    phone: "Enter a valid gym phone number (10 to 15 digits).",
    address: "Address must be 300 characters or fewer.",
    upi_id: "Enter a UPI ID like powergym@okicici.",
    upi_payee_name: "The name shown to payers must be 100 characters or fewer."
};

export function validateGymSettings(request, response, next) {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        return response.status(400).json({ status: "error", message: fieldMessages[field] || "Send name, phone, address, upi_id and upi_payee_name only." });
    }
    const problem = upiIdProblem(parsed.data.upi_id);
    if (problem) return response.status(400).json({ status: "error", message: problem });
    request.validatedSettings = parsed.data;
    next();
}
