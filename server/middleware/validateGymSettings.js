import { z } from "zod";
import { upiIdProblem } from "../../assets/js/upi.js";
import { reminderTemplateProblem } from "../../assets/js/reminderMessage.js";

const optionalText = (max) => z.preprocess(
    (value) => typeof value === "string" ? (value.trim() || null) : value,
    z.string().max(max).nullable().optional()
);

const LANGUAGES = ["en", "hi", "mr"];
const DATE_FORMATS = ["DD MMM YYYY", "DD/MM/YYYY"];

// Preferences saved for the gym (migration 015); they used to live only in the browser.
const preferenceFields = {
    language: z.enum(LANGUAGES).optional(),
    date_format: z.enum(DATE_FORMATS).optional(),
    expiry_reminder_days: z.number().int().min(0).max(90).optional(),
    payment_reminders: z.boolean().optional(),
    inactivity_reminders: z.boolean().optional()
};

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
    upi_payee_name: optionalText(100),
    ...preferenceFields
}).strict();

const fieldMessages = {
    name: "Gym name is required (up to 120 characters).",
    phone: "Enter a valid gym phone number (10 to 15 digits).",
    address: "Address must be 300 characters or fewer.",
    upi_id: "Enter a UPI ID like powergym@okicici.",
    upi_payee_name: "The name shown to payers must be 100 characters or fewer.",
    language: "Choose English, Hindi or Marathi.",
    date_format: "Choose DD MMM YYYY or DD/MM/YYYY.",
    expiry_reminder_days: "The expiry reminder window must be 0 to 90 days.",
    payment_reminders: "Payment reminders must be on or off.",
    inactivity_reminders: "Inactive-member reminders must be on or off."
};

export function validateGymSettings(request, response, next) {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        return response.status(400).json({ status: "error", message: fieldMessages[field] || "Send gym details, UPI details and preferences only." });
    }
    const problem = upiIdProblem(parsed.data.upi_id);
    if (problem) return response.status(400).json({ status: "error", message: problem });
    request.validatedSettings = parsed.data;
    next();
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// "Move my saved data to the cloud": what an older version kept in one browser.
const localDataSchema = z.object({
    preferences: z.object(preferenceFields).strict().optional(),
    expiry_reminder_template: z.object({
        language: z.enum(LANGUAGES),
        body: z.string()
    }).strict().optional(),
    expiry_reminders: z.array(z.object({
        membership_id: z.string().uuid(),
        end_date: isoDate,
        sent_at: z.string().datetime({ offset: true })
    }).strict()).max(5000).optional()
}).strict();

export function validateLocalDataImport(request, response, next) {
    const parsed = localDataSchema.safeParse(request.body);
    if (!parsed.success) {
        return response.status(400).json({ status: "error", message: "Send preferences, expiry_reminder_template and expiry_reminders only, in the expected format." });
    }
    const template = parsed.data.expiry_reminder_template;
    const problem = template ? reminderTemplateProblem(template.body) : "";
    // A message that no longer passes the rules is left behind, not a reason to fail the move.
    const now = Date.now();
    request.localData = {
        preferences: parsed.data.preferences || {},
        expiryReminderTemplate: template && !problem ? { language: template.language, body: template.body.trim() } : null,
        // Marks dated in the future are clock errors; they are kept as "now".
        expiryReminders: (parsed.data.expiry_reminders || []).map((mark) => ({
            ...mark,
            sent_at: new Date(Math.min(Date.parse(mark.sent_at), now)).toISOString()
        }))
    };
    next();
}
