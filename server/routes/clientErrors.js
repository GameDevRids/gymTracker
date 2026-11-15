import express from "express";
import { z } from "zod";
import { captureClientError } from "../config/monitoring.js";
import { createLimit } from "../middleware/authRateLimit.js";

// Errors from the app in the browser, passed on to Sentry (the page may only talk to its own
// server, so it cannot reach Sentry directly). No sign-in is needed, because errors can happen
// on the sign-in screen; the size and rate are limited and the text is scrubbed before sending.
const reportSchema = z.object({
    message: z.string().max(500),
    stack: z.string().max(4000).optional(),
    source: z.string().max(300).optional(),
    view: z.string().max(40).regex(/^[a-z-]*$/).optional(),
    version: z.string().max(40).regex(/^[\w.+-]*$/).optional()
}).strict();

export function createClientErrorsRouter({ capture = captureClientError } = {}) {
    const router = express.Router();
    router.post("/", createLimit(30, "Too many error reports."), (request, response) => {
        const parsed = reportSchema.safeParse(request.body);
        if (parsed.success) capture(parsed.data);
        // Always the same short answer: the page does not wait on, or learn anything from, it.
        response.status(204).end();
    });
    return router;
}

export default createClientErrorsRouter();
