import test from "node:test";
import assert from "node:assert/strict";
import {
    apiClient,
    clearAuthSession,
    resolveApiOrigin,
    setAuthSession
} from "../../assets/js/api/apiClient.js";

function jsonResponse(status, value) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => "application/json" },
        json: async () => value
    };
}

test("API origin stays same-origin for the backend-hosted app and supports Live Server", () => {
    assert.equal(resolveApiOrigin(new URL("http://127.0.0.1:3123")), "http://127.0.0.1:3123");
    assert.equal(resolveApiOrigin(new URL("http://localhost:3001")), "http://localhost:3001");
    assert.equal(resolveApiOrigin(new URL("http://127.0.0.1:5500")), "http://localhost:3001");
});

test("API client refreshes once after 401 and retries with the new bearer token", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    let apiAttempts = 0;
    setAuthSession({ access_token: "old-access", refresh_token: "old-refresh", expires_in: 3600 });
    globalThis.fetch = async (url, options) => {
        const path = new URL(url).pathname;
        requests.push({ path, options });
        if (path === "/api/auth/refresh") {
            return jsonResponse(200, {
                data: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }
            });
        }
        apiAttempts += 1;
        return apiAttempts === 1
            ? jsonResponse(401, { message: "Expired" })
            : jsonResponse(200, { status: "success" });
    };
    try {
        assert.deepEqual(await apiClient.get("/api/members"), { status: "success" });
        assert.equal(requests.length, 3);
        assert.equal(requests[0].options.headers.Authorization, "Bearer old-access");
        assert.equal(requests[2].options.headers.Authorization, "Bearer new-access");
    } finally {
        clearAuthSession();
        globalThis.fetch = originalFetch;
    }
});

test("API client never forwards the owner token to a custom origin", async () => {
    const originalFetch = globalThis.fetch;
    let requestOptions;
    setAuthSession({ access_token: "owner-access", refresh_token: "owner-refresh", expires_in: 3600 });
    globalThis.fetch = async (_url, options) => {
        requestOptions = options;
        return jsonResponse(401, { message: "Unauthorized" });
    };
    try {
        await assert.rejects(apiClient.get("https://other.example.test/api/whatsapp/status"), /Unauthorized/);
        assert.equal(Object.hasOwn(requestOptions.headers, "Authorization"), false);
    } finally {
        clearAuthSession();
        globalThis.fetch = originalFetch;
    }
});
