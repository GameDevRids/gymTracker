import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readCookie } from "./sessionCookie.js";

// Optional HTTP Basic Auth gate for private demo deployments, enabled by DEMO_PASSWORD.
//
// After a successful Basic Auth check the gate also sets a short-lived, signed,
// HttpOnly cookie. The frontend's API calls send their own "Authorization: Bearer"
// header, which replaces the browser's cached Basic credentials, so without the
// cookie every signed-in API request would be rejected by this gate.

export const DEMO_COOKIE_NAME = "gympulse_demo";
export const DEMO_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

const digest = (value) => createHash("sha256").update(String(value)).digest();
// Hashing both sides first gives equal-length buffers, as timingSafeEqual requires.
const safeEqual = (supplied, expected) => timingSafeEqual(digest(supplied), digest(expected));

function signature(password, expiresAt) {
    return createHmac("sha256", password).update(`gympulse-demo-gate-v1:${expiresAt}`).digest("base64url");
}

export function createDemoCookieValue(password, now = Date.now()) {
    const expiresAt = Math.floor(now / 1000) + DEMO_COOKIE_MAX_AGE_SECONDS;
    return `${expiresAt}.${signature(password, expiresAt)}`;
}

export function isValidDemoCookie(value, password, now = Date.now()) {
    const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(value || ""));
    if (!match) return false;
    const expiresAt = Number(match[1]);
    const signatureMatches = safeEqual(match[2], signature(password, expiresAt));
    return signatureMatches && expiresAt > Math.floor(now / 1000);
}

function hasValidBasicAuth(header, password) {
    const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(header || "");
    const decoded = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
    const separator = decoded.indexOf(":");
    const username = separator > 0 ? decoded.slice(0, separator) : "";
    const suppliedPassword = separator > 0 ? decoded.slice(separator + 1) : "";
    // Always run the comparison so timing does not reveal whether a username was sent.
    const passwordMatches = safeEqual(suppliedPassword, password);
    return Boolean(username) && passwordMatches;
}

export function requireDemoAuth(password = process.env.DEMO_PASSWORD, { now = () => Date.now() } = {}) {
    return (request, response, next) => {
        if (!password || request.path === "/health") return next();

        if (isValidDemoCookie(readCookie(request, DEMO_COOKIE_NAME), password, now())) return next();

        if (hasValidBasicAuth(request.get("Authorization"), password)) {
            response.append("Set-Cookie", [
                `${DEMO_COOKIE_NAME}=${createDemoCookieValue(password, now())}`,
                "Path=/",
                `Max-Age=${DEMO_COOKIE_MAX_AGE_SECONDS}`,
                "HttpOnly",
                "SameSite=Lax",
                ...(request.secure ? ["Secure"] : [])
            ].join("; "));
            return next();
        }

        response.setHeader("WWW-Authenticate", 'Basic realm="GymPulse Demo"');
        return response.status(401).json({ error: "Demo password required." });
    };
}
