const normalizeApiOrigin = () => {
    if (typeof window === "undefined" || !window.location) return "http://localhost:3001";
    const origin = window.location.origin || "http://localhost:3001";
    return origin.includes("localhost") || origin.includes("127.0.0.1") ? "http://localhost:3001" : origin;
};

export const API_BASE_URL = normalizeApiOrigin();

export const apiClient = {
    async request(path, { method = "GET", body, params = {}, headers = {}, timeoutMs = 15000 } = {}) {
        const url = new URL(path, `${API_BASE_URL.replace(/\/$/, "")}/`);
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null || value === "") continue;
            url.searchParams.set(key, String(value));
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...headers
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });

            const contentType = response.headers.get("content-type") || "";
            const payload = contentType.includes("application/json") ? await response.json() : {};
            if (!response.ok) {
                const message = payload?.message || payload?.error || `The API request failed with status ${response.status}.`;
                throw new Error(message);
            }

            return payload;
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
