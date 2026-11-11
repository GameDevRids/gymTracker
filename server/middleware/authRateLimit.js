import { rateLimit } from "express-rate-limit";

export const AUTH_RATE_LIMIT = { windowMs: 15 * 60 * 1000, limit: 10 };

// Strict per-IP limit for sign-in and token refresh. Client IPs come from
// X-Forwarded-For only because server.js trusts exactly one proxy hop (Render).
export function createAuthRateLimit() {
    return rateLimit({
        ...AUTH_RATE_LIMIT,
        standardHeaders: true,
        legacyHeaders: false,
        // JSON so the frontend's API client can show the message instead of a generic status error.
        message: { status: "error", message: "Too many sign-in attempts. Please wait 15 minutes and try again." }
    });
}
