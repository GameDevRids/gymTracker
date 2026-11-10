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

let accessToken = "";
let refreshToken = "";
let refreshTimer;
let refreshPromise;
let unauthorizedHandler = () => {};
const REFRESH_TOKEN_KEY = "gympulse.refresh-token";

function isAuthEndpoint(path) {
    try {
        const pathname = new URL(path, `${API_BASE_URL.replace(/\/$/, "")}/`).pathname;
        return pathname === "/api/auth/login" || pathname === "/api/auth/refresh";
    } catch {
        return false;
    }
}

async function refreshSession() {
    if (!refreshToken) throw new Error("Your session has expired. Sign in again.");
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
        const response = await fetch(new URL("/api/auth/refresh", `${API_BASE_URL.replace(/\/$/, "")}/`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: refreshToken })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.data?.access_token) {
            clearAuthSession();
            throw new Error(payload?.message || "Your session has expired. Sign in again.");
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
    const newAccessToken = session?.access_token || "";
    const newRefreshToken = session?.refresh_token || "";
    if (typeof globalThis.sessionStorage !== "undefined") {
        if (newRefreshToken) globalThis.sessionStorage.setItem(REFRESH_TOKEN_KEY, newRefreshToken);
        else globalThis.sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    }
    accessToken = newAccessToken;
    refreshToken = newRefreshToken;
    clearTimeout(refreshTimer);
    if (accessToken && refreshToken && Number.isFinite(session?.expires_in)) {
        refreshTimer = setTimeout(() => {
            refreshSession().catch(() => unauthorizedHandler());
        }, Math.max(1000, (session.expires_in - 60) * 1000));
    }
}

export function clearAuthSession() {
    accessToken = "";
    refreshToken = "";
    clearTimeout(refreshTimer);
    if (typeof globalThis.sessionStorage !== "undefined") {
        globalThis.sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    }
}

export async function restoreAuthSession() {
    if (typeof globalThis.sessionStorage === "undefined") return null;
    const storedRefreshToken = globalThis.sessionStorage.getItem(REFRESH_TOKEN_KEY);
    if (!storedRefreshToken) return null;
    refreshToken = storedRefreshToken;
    return refreshSession();
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
