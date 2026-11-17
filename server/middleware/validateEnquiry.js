import { z } from "zod";
import { cleanEnquiryPhone } from "../../assets/js/enquiries.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
const optionalText = (max) => z.preprocess((value) => (typeof value === "string" ? value.trim() || null : value), z.string().max(max).nullable().optional());
// Any common way of writing an Indian mobile; saved as +91 and 10 digits.
const phone = z.string().max(20).transform((value, context) => {
    const clean = cleanEnquiryPhone(value);
    if (!clean) context.addIssue({ code: "custom", message: "phone" });
    return clean;
});

const fields = {
    full_name: z.string().trim().min(1).max(120),
    phone,
    interest_plan_id: uuid.nullable().optional(),
    interest_text: optionalText(120),
    source: z.enum(["walk_in", "instagram", "friend", "other"]),
    note: optionalText(500),
    follow_up_on: date.nullable().optional()
};

const MESSAGES = {
    full_name: "Enter the visitor's name.",
    phone: "Enter a 10-digit Indian mobile number.",
    interest_plan_id: "Choose one of your plans, or Not sure.",
    interest_text: "Keep what they are interested in to 120 characters.",
    source: "Choose how they heard about the gym.",
    note: "Keep the note to 500 characters.",
    follow_up_on: "Choose a follow-up date.",
    stage: "Choose New, Contacted or Not interested.",
    consent: "Answer the WhatsApp question.",
    agree: "Answer the WhatsApp question.",
    member_id: "Choose the member."
};

function reply(schema, key) {
    return (request, response, next) => {
        const parsed = schema.safeParse(request.body ?? {});
        if (!parsed.success) {
            const field = parsed.error.issues[0]?.path[0];
            return response.status(400).json({ status: "error", message: MESSAGES[field] || "Check the enquiry details.", code: "invalid" });
        }
        if (key === "enquiryChanges" && !Object.keys(parsed.data).length) {
            return response.status(400).json({ status: "error", message: "Nothing to change.", code: "invalid" });
        }
        request[key] = parsed.data;
        next();
    };
}

// A new enquiry: consent is the visitor's own answer on the consent step (true, or false for No thanks).
export const validateNewEnquiry = reply(z.object({ ...fields, consent: z.boolean().optional() }).strict(), "enquiryInput");
// Editing: any of the fields, or the stage (Joined only happens through Join now).
export const validateEnquiryChanges = reply(z.object({ ...fields, stage: z.enum(["new", "contacted", "not_interested"]) }).partial().strict(), "enquiryChanges");
export const validateEnquiryConsent = reply(z.object({ agree: z.boolean() }).strict(), "enquiryConsent");
export const validateEnquiryContacted = reply(z.object({ follow_up_on: date.nullable().optional() }).strict(), "enquiryContacted");
export const validateEnquiryJoin = reply(z.object({ member_id: uuid }).strict(), "enquiryJoin");

export function validateEnquiryId(request, response, next) {
    if (!uuid.safeParse(request.params.id).success) return response.status(400).json({ status: "error", message: "Enquiry ID must be a valid UUID." });
    next();
}
