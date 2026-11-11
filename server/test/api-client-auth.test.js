import test from "node:test";
import assert from "node:assert/strict";
import {
    apiClient,
    clearAuthSession,
    restoreAuthSession,
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

test("API origin defaults to same-origin and honors an explicit backend origin", () => {
    assert.equal(resolveApiOrigin(new URL("http://127.0.0.1:3123")), "http://127.0.0.1:3123");
    assert.equal(resolveApiOrigin(new URL("http://localhost:3001")), "http://localhost:3001");
    assert.equal(resolveApiOrigin(new URL("http://127.0.0.1:5500")), "http://127.0.0.1:5500");
    assert.equal(resolveApiOrigin(new URL("http://localhost:5500"), "https://api.example.test"), "https://api.example.test");
    assert.equal(resolveApiOrigin(new URL("http://localhost:5500"), "/backend"), "http://localhost:5500");
});

test("API client refreshes once after 401 and retries with the new bearer token", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    let apiAttempts = 0;
    setAuthSession({ access_token: "old-access", expires_in: 3600 });
    globalThis.fetch = async (url, options) => {
        const path = new URL(url).pathname;
        requests.push({ path, options });
        if (path === "/api/auth/refresh") {
            return jsonResponse(200, { data: { access_token: "new-access", expires_in: 3600 } });
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
    setAuthSession({ access_token: "owner-access", expires_in: 3600 });
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

test("session restore uses the HttpOnly refresh cookie and removes the legacy stored token", async () => {
    const originalFetch = globalThis.fetch;
    const originalStorage = globalThis.sessionStorage;
    const values = new Map([["gympulse.refresh-token", "legacy-refresh"]]);
    globalThis.sessionStorage = {
        getItem(key) { return values.get(key) || null; },
        setItem(key, value) { values.set(key, value); },
        removeItem(key) { values.delete(key); }
    };
    let refreshRequest;
    globalThis.fetch = async (url, options) => {
        const path = new URL(url).pathname;
        if (path === "/api/auth/refresh") {
            refreshRequest = options;
            return jsonResponse(200, { data: { access_token: "restored-access", expires_in: 3600 } });
        }
        return jsonResponse(200, { status: "success", authorization: options.headers.Authorization });
    };
    try {
        const session = await restoreAuthSession();
        assert.equal(session.access_token, "restored-access");
        assert.equal(refreshRequest.method, "POST");
        assert.equal(refreshRequest.credentials, "same-origin");
        assert.equal(refreshRequest.body, undefined);
        assert.equal(values.has("gympulse.refresh-token"), false);
        assert.equal((await apiClient.get("/api/members")).authorization, "Bearer restored-access");
    } finally {
        clearAuthSession();
        globalThis.fetch = originalFetch;
        if (originalStorage === undefined) delete globalThis.sessionStorage;
        else globalThis.sessionStorage = originalStorage;
    }
});

test("session restore returns null without a saved session and throws for server failures", async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => jsonResponse(401, { status: "error", message: "No saved session. Sign in again." });
        assert.equal(await restoreAuthSession(), null);

        globalThis.fetch = async () => jsonResponse(503, { status: "error", message: "Authentication service is unavailable." });
        await assert.rejects(restoreAuthSession(), /Authentication service is unavailable/);

        globalThis.fetch = async () => { throw new TypeError("network down"); };
        await assert.rejects(restoreAuthSession(), /could not reach the server/);
    } finally {
        clearAuthSession();
        globalThis.fetch = originalFetch;
    }
});
