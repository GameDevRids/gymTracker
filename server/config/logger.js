import pino from "pino";
import pinoHttp from "pino-http";
import { maskPath, scrubText } from "./scrub.js";

// Request logs keep only the method, the path with ids and tokens masked, the status and how
// long it took. No IP addresses, headers (cookies, tokens, user agent), query strings or bodies.
// Error logs keep the error's type, code and status, with personal data scrubbed from its text.

// A second line of defence if a log call ever passes something it should not.
export const logRedaction = {
    paths: [
        "req.headers",
        "req.remoteAddress",
        "req.remotePort",
        "req.body",
        "res.headers",
        'res.headers["set-cookie"]',
        "phone",
        "*.phone",
        "*.phoneNumber",
        "*.email",
        "*.password",
        "*.access_token",
        "*.refresh_token"
    ],
    censor: "[REDACTED]"
};

export function serializeError(error) {
    if (!error || typeof error !== "object") return error;
    return {
        type: error.constructor?.name || error.name || "Error",
        message: scrubText(error.message),
        ...(error.code ? { code: String(error.code) } : {}),
        ...(Number.isInteger(error.status ?? error.statusCode) ? { status: error.status ?? error.statusCode } : {}),
        ...(error.details ? { details: scrubText(String(error.details)) } : {}),
        ...(error.hint ? { hint: scrubText(String(error.hint)) } : {}),
        stack: scrubText(error.stack)
    };
}

export function serializeRequest(request) {
    return { id: request.id, method: request.method, path: maskPath(request.url) };
}

export function serializeResponse(response) {
    return { statusCode: response.statusCode };
}

export const logger = pino({
    level: process.env.LOG_LEVEL || "info",
    redact: logRedaction,
    serializers: { err: serializeError }
});

export const httpLoggerOptions = {
    serializers: { req: serializeRequest, res: serializeResponse, err: serializeError },
    customSuccessMessage: (request, response) => `${request.method} ${maskPath(request.originalUrl || request.url)} ${response.statusCode}`,
    customErrorMessage: (request, response) => `${request.method} ${maskPath(request.originalUrl || request.url)} ${response.statusCode}`
};

export const httpLogger = pinoHttp({ logger, ...httpLoggerOptions });
