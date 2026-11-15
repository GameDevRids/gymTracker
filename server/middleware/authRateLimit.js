import { rateLimit } from "express-rate-limit";

export const AUTH_RATE_LIMIT = { windowMs: 15 * 60 * 1000, limit: 10 };
// Restoring a session needs a valid HttpOnly refresh cookie, and every page load and tab uses
// one, so several staff phones on one gym Wi-Fi need more room than password sign-in does.
export const REFRESH_RATE_LIMIT = { windowMs: 15 * 60 * 1000, limit: 60 };

const message = { status: "error", message: "Too many sign-in attempts. Please wait 15 minutes and try again." };

// Strict per-IP limit for password sign-in. Client IPs come from X-Forwarded-For only because
// server.js trusts exactly one proxy hop (Render).
export function createAuthRateLimit() {
    return rateLimit({
        ...AUTH_RATE_LIMIT,
        standardHeaders: true,
        legacyHeaders: false,
        // JSON so the frontend's API client can show the message instead of a generic status error.
        message
    });
}

export function createRefreshRateLimit() {
    return rateLimit({ ...REFRESH_RATE_LIMIT, standardHeaders: true, legacyHeaders: false, message });
}

/** A per-IP limit over 15 minutes with its own message, for other sensitive endpoints. */
export function createLimit(limit, text) {
    return rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, message: { status: "error", message: text } });
}
