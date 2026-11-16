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
// When the access token runs out (ms), so a reopened app can refresh before using it.
let sessionExpiresAt = 0;
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

// status 401: the saved session is gone (revoked, expired, signed out). Anything else (0 = no
// network, 5xx = the server is down or still waking up) is temporary, and never signs out.
class SessionError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/** True for a refresh failure worth retrying: the session itself may still be fine. */
export function isSessionRetryable(error) {
    return error instanceof SessionError && error.status !== 401;
}

const REFRESH_TIMEOUT_MS = 60000;
// Between retries while the server wakes up or the connection is down.
export const RESTORE_RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 30000];

// Exchanges the refresh cookie for a new access token. Concurrent callers share one request.
async function refreshSession() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
        let response;
        try {
            response = await fetch(new URL("/api/auth/refresh", `${API_BASE_URL.replace(/\/$/, "")}/`), {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                ...(typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) } : {})
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

function scheduleRefresh(delayMs) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshSession().catch((error) => {
            // Only a rejected session signs out; an outage tries again shortly.
            if (isSessionRetryable(error)) scheduleRefresh(30000);
            else unauthorizedHandler();
        });
    }, delayMs);
    refreshTimer.unref?.();
}

export function setAuthSession(session) {
    removeLegacyRefreshToken();
    accessToken = session?.access_token || "";
    clearTimeout(refreshTimer);
    sessionExpiresAt = 0;
    if (accessToken && Number.isFinite(session?.expires_in)) {
        sessionExpiresAt = Date.now() + session.expires_in * 1000;
        scheduleRefresh(Math.max(1000, (session.expires_in - 60) * 1000));
    }
}

/**
 * Refreshes now if the access token has run out or is about to (a phone pauses timers while
 * the app is in the background). Call when the app comes back into view.
 */
export async function ensureFreshSession({ withinMs = 2 * 60 * 1000 } = {}) {
    if (!accessToken || !sessionExpiresAt) return null;
    if (sessionExpiresAt - Date.now() > withinMs) return null;
    return refreshSession();
}

/** Forgets the in-memory session. The server clears the refresh cookie on logout. */
export function clearAuthSession() {
    accessToken = "";
    sessionExpiresAt = 0;
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

/**
 * Restores the session on app open, waiting out a sleeping server or a dropped connection:
 * onWaiting(attempt, error) is called before each retry (show "Connecting…"). Resolves to the
 * session, or null when there is no saved session. Only gives up after maxAttempts.
 */
export async function restoreAuthSessionWithRetry({
    onWaiting = () => {},
    delays = RESTORE_RETRY_DELAYS_MS,
    maxAttempts = Infinity,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await restoreAuthSession();
        } catch (error) {
            if (!isSessionRetryable(error) || attempt >= maxAttempts) throw error;
            onWaiting(attempt, error);
            await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
        }
    }
}

export function setUnauthorizedHandler(handler) {
    unauthorizedHandler = typeof handler === "function" ? handler : () => {};
}

export const apiClient = {
    async request(path, { method = "GET", body, params = {}, headers = {}, timeoutMs = 15000, responseType = "json" } = {}) {
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
            // A file download (for example the gym's Excel export): the bytes and the file name.
            if (responseType === "blob" && response.ok) {
                const disposition = response.headers.get("content-disposition") || "";
                return { blob: await response.blob(), filename: /filename="([^"]+)"/.exec(disposition)?.[1] || "" };
            }
            const payload = contentType.includes("application/json") ? await response.json() : {};
            if (response.status === 401 && url.origin === new URL(API_BASE_URL).origin
                && !retry && accessToken && !isAuthEndpoint(path)) {
                try {
                    await refreshSession();
                    return send(true);
                } catch (error) {
                    // A rejected session signs out. No network or a sleeping server does not: the
                    // request simply fails this time, and the session is still there for the next.
                    if (!isSessionRetryable(error)) {
                        clearAuthSession();
                        unauthorizedHandler();
                    }
                    throw error;
                }
            }
            if (!response.ok) {
                const message = payload?.message || payload?.error || `The API request failed with status ${response.status}.`;
                // The server already knows about these, so the error reporter skips them.
                throw Object.assign(new Error(message), { status: response.status, isApiError: true, ...(typeof payload?.code === "string" ? { code: payload.code } : {}) });
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
