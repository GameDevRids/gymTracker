import { z } from "zod";
import { WELCOME_LANGUAGES, welcomeTemplateProblem } from "../../assets/js/welcomeMessage.js";

const REMINDER_TYPES = ["welcome", "expiry", "payment", "inactive"];

function sendValidationError(response, message) {
    return response.status(400).json({ status: "error", message });
}

// Only wa.me sends are logged from the browser. Cloud API rows will be written by the server
// itself once a send succeeds, so the browser cannot claim a Cloud API delivery.
const messagePayloadSchema = z.object({
    reminder_type: z.enum(REMINDER_TYPES),
    language: z.enum(WELCOME_LANGUAGES).optional(),
    body: z.string().max(4096).optional()
}).strict();

export function validateMessagePayload(request, response, next) {
    const parsed = messagePayloadSchema.safeParse(request.body);
    if (!parsed.success) {
        return sendValidationError(response, "Send reminder_type (welcome, expiry, payment or inactive), and optionally language and body.");
    }
    request.validatedMessage = {
        reminderType: parsed.data.reminder_type,
        channel: "wa_me",
        status: "sent",
        language: parsed.data.language ?? null,
        body: parsed.data.body ?? null
    };
    next();
}

export function validateMessageListQuery(request, response, next) {
    const type = request.query.reminder_type;
    if (type !== undefined && !REMINDER_TYPES.includes(type)) {
        return sendValidationError(response, "reminder_type must be welcome, expiry, payment or inactive.");
    }
    request.messageListQuery = { reminderType: type };
    next();
}

export function validateTemplateParams(request, response, next) {
    if (request.params.key !== "welcome") return sendValidationError(response, "Unknown message template.");
    if (request.params.language !== undefined && !WELCOME_LANGUAGES.includes(request.params.language)) {
        return sendValidationError(response, "Language must be en, hi or mr.");
    }
    next();
}

export function validateTemplateBody(request, response, next) {
    const body = request.body?.body;
    const keys = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? Object.keys(request.body) : null;
    if (!keys || keys.length !== 1 || keys[0] !== "body") return sendValidationError(response, "Send the template as { body }.");
    const problem = welcomeTemplateProblem(body);
    if (problem) return sendValidationError(response, problem);
    request.validatedTemplateBody = body.trim();
    next();
}
