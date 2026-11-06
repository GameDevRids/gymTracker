import pino from "pino";
import pinoHttp from "pino-http";

export const logger = pino({
    level: process.env.LOG_LEVEL || "info",
    redact: {
        paths: [
            "req.headers.authorization",
            "req.body.phone",
            "req.body.*.phone",
            "err.phone",
            "err.response.phone",
            "phone",
            "*.phone",
            "*.phoneNumber"
        ],
        censor: "[REDACTED]"
    }
});

export function serializeRequest(request) {
    const headers = { ...request.headers };
    if (headers.authorization) headers.authorization = "[REDACTED]";
    if (headers["x-whatsapp-to"]) headers["x-whatsapp-to"] = "[REDACTED]";
    return {
        id: request.id,
        method: request.method,
        url: request.url.split("?")[0],
        headers
    };
}

export const httpLogger = pinoHttp({
    logger,
    serializers: { req: serializeRequest }
});
