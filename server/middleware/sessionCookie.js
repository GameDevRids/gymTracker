// Keeps the Supabase refresh token in an HttpOnly cookie so page scripts never see it.
// The cookie is limited to /api/auth, so it is only sent to login, refresh and logout.
//
// "Keep me signed in" (the default) gives the cookie a Max-Age, so it survives closing the
// installed app, switching apps and restarting the phone; every refresh sets it again, so a
// signed-in owner stays signed in for REFRESH_COOKIE_DAYS of inactivity. Unticked, it has no
// Max-Age and ends with the browser session (for a shared computer). That choice is remembered
// in a second cookie, because a refresh has to set the rotated token the same way.

export const REFRESH_COOKIE_NAME = "gympulse_refresh";
export const REMEMBER_COOKIE_NAME = "gympulse_remember";
export const REFRESH_COOKIE_DAYS = 60;
const REFRESH_COOKIE_PATH = "/api/auth";
const MAX_AGE_SECONDS = REFRESH_COOKIE_DAYS * 24 * 60 * 60;

export function readCookie(request, name) {
    for (const part of String(request.get("Cookie") || "").split(";")) {
        const separator = part.indexOf("=");
        if (separator > 0 && part.slice(0, separator).trim() === name) {
            try {
                return decodeURIComponent(part.slice(separator + 1).trim());
            } catch {
                return "";
            }
        }
    }
    return "";
}

function cookieAttributes(request) {
    return [`Path=${REFRESH_COOKIE_PATH}`, "HttpOnly", "SameSite=Strict", ...(request.secure ? ["Secure"] : [])];
}

function cookieHeader(request, name, value, { maxAge } = {}) {
    return [`${name}=${encodeURIComponent(value)}`, ...cookieAttributes(request), ...(maxAge === undefined ? [] : [`Max-Age=${maxAge}`])].join("; ");
}

/**
 * Sets the refresh cookie. persistent = "keep me signed in": the cookie (and the cookie that
 * remembers the choice) last REFRESH_COOKIE_DAYS from now; otherwise they end with the session.
 */
export function setRefreshCookie(request, response, refreshToken, { persistent = false } = {}) {
    response.append("Set-Cookie", cookieHeader(request, REFRESH_COOKIE_NAME, refreshToken, persistent ? { maxAge: MAX_AGE_SECONDS } : {}));
    response.append("Set-Cookie", cookieHeader(request, REMEMBER_COOKIE_NAME, persistent ? "1" : "", { maxAge: persistent ? MAX_AGE_SECONDS : 0 }));
}

export function clearRefreshCookie(request, response) {
    response.append("Set-Cookie", cookieHeader(request, REFRESH_COOKIE_NAME, "", { maxAge: 0 }));
    response.append("Set-Cookie", cookieHeader(request, REMEMBER_COOKIE_NAME, "", { maxAge: 0 }));
}

export function readRefreshCookie(request) {
    return readCookie(request, REFRESH_COOKIE_NAME);
}

/** Whether this browser asked to stay signed in (so a refresh keeps the cookie persistent). */
export function readRememberCookie(request) {
    return readCookie(request, REMEMBER_COOKIE_NAME) === "1";
}

/** Returns the session to send to the browser, without the refresh token. */
export function publicSession(session) {
    const { refresh_token: _refreshToken, ...rest } = session || {};
    return rest;
}

/**
 * Rejects cross-site browser requests to the cookie-based auth endpoints.
 * Browsers send Origin on POST; Sec-Fetch-Site is a fallback. Requests with
 * neither header come from non-browser clients, which cannot carry a victim's cookie.
 */
export function requireSameOrigin(request, response, next) {
    const origin = request.get("Origin");
    const expected = `${request.protocol}://${request.get("Host")}`;
    const fetchSite = request.get("Sec-Fetch-Site");
    const crossSite = origin
        ? origin !== expected
        : Boolean(fetchSite) && !["same-origin", "none"].includes(fetchSite);
    if (crossSite) return response.status(403).json({ status: "error", message: "Cross-site authentication requests are not allowed." });
    next();
}
