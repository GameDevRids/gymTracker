export function resolveApiOrigin(
    location = globalThis.window?.location,
    configuredBase = globalThis.window?.GYMPULSE_API_BASE || globalThis.document?.querySelector('meta[name="api-base"]')?.content
) {
    if (configuredBase?.trim()) {
        return new URL(configuredBase.trim(), location?.origin || "http://localhost:3001").origin;
    }
    if (!location?.origin) return "http://localhost:3001";
    return location.origin;
}

export const API_BASE_URL = resolveApiOrigin();

// The access token lives only in memory. The refresh token is kept by the server in an
// HttpOnly cookie that page scripts cannot read; it is sent automatically to /api/auth.
let accessToken = "";
let refreshTimer;
let refreshPromise;
let unauthorizedHandler = () => {};
// Older versions stored the refresh token here; it is removed whenever the session changes.
const LEGACY_REFRESH_TOKEN_KEY = "gympulse.refresh-token";

function removeLegacyRefreshToken() {
    try {
        globalThis.sessionStorage?.removeItem(LEGACY_REFRESH_TOKEN_KEY);
    } catch {
        // Storage can be blocked; there is nothing to remove then.
    }
}

function isAuthEndpoint(path) {
    try {
        const pathname = new URL(path, `${API_BASE_URL.replace(/\/$/, "")}/`).pathname;
        return pathname === "/api/auth/login" || pathname === "/api/auth/refresh";
    } catch {
        return false;
    }
}

class SessionError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

// Exchanges the refresh cookie for a new access token. Concurrent callers share one request.
async function refreshSession() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
        let response;
        try {
            response = await fetch(new URL("/api/auth/refresh", `${API_BASE_URL.replace(/\/$/, "")}/`), {
                method: "POST",
                credentials: "same-origin"
            });
        } catch {
            throw new SessionError("GymPulse could not reach the server to restore your session.", 0);
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.data?.access_token) {
            if (response.status === 401 || response.ok) clearAuthSession();
            throw new SessionError(payload?.message || "Your session has expired. Sign in again.", response.ok ? 401 : response.status);
        }
        setAuthSession(payload.data);
        return payload.data;
    })();
    try {
        return await refreshPromise;
    } finally {
        refreshPromise = null;
    }
}

export function setAuthSession(session) {
    removeLegacyRefreshToken();
    accessToken = session?.access_token || "";
    clearTimeout(refreshTimer);
    if (accessToken && Number.isFinite(session?.expires_in)) {
        refreshTimer = setTimeout(() => {
            refreshSession().catch(() => unauthorizedHandler());
        }, Math.max(1000, (session.expires_in - 60) * 1000));
    }
}

/** Forgets the in-memory session. The server clears the refresh cookie on logout. */
export function clearAuthSession() {
    accessToken = "";
    clearTimeout(refreshTimer);
    removeLegacyRefreshToken();
}

/**
 * Restores the session after a page load from the refresh cookie.
 * Resolves to null when there is no saved session, and throws for other failures.
 */
export async function restoreAuthSession() {
    removeLegacyRefreshToken();
    try {
        return await refreshSession();
    } catch (error) {
        if (error instanceof SessionError && error.status === 401) return null;
        throw error;
    }
}

export function setUnauthorizedHandler(handler) {
    unauthorizedHandler = typeof handler === "function" ? handler : () => {};
}

export const apiClient = {
    async request(path, { method = "GET", body, params = {}, headers = {}, timeoutMs = 15000 } = {}) {
        const url = new URL(path, `${API_BASE_URL.replace(/\/$/, "")}/`);
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null || value === "") continue;
            url.searchParams.set(key, String(value));
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const rawBody = typeof Blob !== "undefined" && body instanceof Blob;
        const send = async (retry = false) => {
            const response = await fetch(url, {
                method,
                headers: {
                    ...(!rawBody ? { "Content-Type": "application/json" } : {}),
                    ...(accessToken && url.origin === new URL(API_BASE_URL).origin ? { Authorization: `Bearer ${accessToken}` } : {}),
                    ...headers
                },
                body: body === undefined ? undefined : rawBody ? body : JSON.stringify(body),
                signal: controller.signal
            });

            const contentType = response.headers.get("content-type") || "";
            const payload = contentType.includes("application/json") ? await response.json() : {};
            if (response.status === 401 && url.origin === new URL(API_BASE_URL).origin
                && !retry && accessToken && !isAuthEndpoint(path)) {
                try {
                    await refreshSession();
                    return send(true);
                } catch (error) {
                    clearAuthSession();
                    unauthorizedHandler();
                    throw error;
                }
            }
            if (!response.ok) {
                const message = payload?.message || payload?.error || `The API request failed with status ${response.status}.`;
                throw new Error(message);
            }
            return payload;
        };
        try {
            return await send();
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error("The API request timed out. Please try again.");
            }
            if (error instanceof Error) {
                throw error;
            }
            throw new Error("The API request could not be completed.");
        } finally {
            clearTimeout(timeout);
        }
    },

    get(path, options = {}) {
        return this.request(path, { ...options, method: "GET" });
    },

    post(path, body, options = {}) {
        return this.request(path, { ...options, method: "POST", body });
    },

    put(path, body, options = {}) {
        return this.request(path, { ...options, method: "PUT", body });
    },

    delete(path, options = {}) {
        return this.request(path, { ...options, method: "DELETE" });
    }
};
