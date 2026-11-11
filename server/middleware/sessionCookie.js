// Keeps the Supabase refresh token in an HttpOnly cookie so page scripts never see it.
// The cookie is limited to /api/auth, so it is only sent to login, refresh and logout.
// It has no Max-Age, so it lasts until the browser session ends.

export const REFRESH_COOKIE_NAME = "gympulse_refresh";
const REFRESH_COOKIE_PATH = "/api/auth";

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

export function setRefreshCookie(request, response, refreshToken) {
    response.append("Set-Cookie", [`${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}`, ...cookieAttributes(request)].join("; "));
}

export function clearRefreshCookie(request, response) {
    response.append("Set-Cookie", [`${REFRESH_COOKIE_NAME}=`, ...cookieAttributes(request), "Max-Age=0"].join("; "));
}

export function readRefreshCookie(request) {
    return readCookie(request, REFRESH_COOKIE_NAME);
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
