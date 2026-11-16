// Staying signed in (assets/js/api/apiClient.js): the session survives a reload through the
// refresh cookie, an expired access token refreshes silently, no network or a sleeping server
// never signs the owner out, and only a rejected refresh shows the sign-in screen.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    apiClient,
    clearAuthSession,
    ensureFreshSession,
    isSessionRetryable,
    restoreAuthSession,
    restoreAuthSessionWithRetry,
    setAuthSession,
    setUnauthorizedHandler
} from "../../assets/js/api/apiClient.js";

const originalFetch = globalThis.fetch;
let signedOut;
let requests;

function jsonResponse(status, value) {
    return { status, ok: status >= 200 && status < 300, headers: { get: () => "application/json" }, json: async () => value };
}

/** Answers /api/auth/refresh with `refresh` (a response or an Error) and everything else with 200. */
function serve(refresh, api = () => jsonResponse(200, { status: "success" })) {
    globalThis.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        requests.push({ path, authorization: options.headers?.Authorization || "" });
        const answer = path === "/api/auth/refresh" ? refresh : api;
        const result = typeof answer === "function" ? answer() : answer;
        if (result instanceof Error) throw result;
        return result;
    };
}

beforeEach(() => {
    signedOut = 0;
    requests = [];
    setUnauthorizedHandler(() => { signedOut += 1; });
});

afterEach(() => {
    clearAuthSession();
    setUnauthorizedHandler(() => {});
    globalThis.fetch = originalFetch;
});

const noRetryWait = { sleep: async () => {} };

test("the session survives a reload: the refresh cookie alone restores it", async () => {
    serve(jsonResponse(200, { data: { access_token: "restored", expires_in: 3600, user: { id: "u1" } } }));
    const session = await restoreAuthSessionWithRetry(noRetryWait);
    assert.equal(session.access_token, "restored");
    assert.deepEqual(requests.map((request) => request.path), ["/api/auth/refresh"]);
    assert.equal((await apiClient.get("/api/members")) && requests.at(-1).authorization, "Bearer restored");
    assert.equal(signedOut, 0);
});

test("an expired access token is refreshed silently and the request retried", async () => {
    setAuthSession({ access_token: "stale", expires_in: 3600 });
    let apiCalls = 0;
    serve(jsonResponse(200, { data: { access_token: "fresh", expires_in: 3600 } }), () => {
        apiCalls += 1;
        return apiCalls === 1 ? jsonResponse(401, { message: "Expired" }) : jsonResponse(200, { status: "success" });
    });
    assert.deepEqual(await apiClient.get("/api/members"), { status: "success" });
    assert.deepEqual(requests.map((request) => request.authorization), ["Bearer stale", "", "Bearer fresh"]);
    assert.equal(signedOut, 0);
});

test("no network during a refresh does not sign out: the request fails, the session stays", async () => {
    setAuthSession({ access_token: "kept", expires_in: 3600 });
    let apiCalls = 0;
    serve(new TypeError("Failed to fetch"), () => {
        apiCalls += 1;
        return apiCalls === 1 ? jsonResponse(401, { message: "Expired" }) : jsonResponse(200, { status: "success", ok: true });
    });
    await assert.rejects(apiClient.get("/api/members"), /could not reach the server/);
    assert.equal(signedOut, 0, "the sign-in screen is not shown");
    // The token is still there for the next request.
    serve(jsonResponse(200, { data: { access_token: "fresh", expires_in: 3600 } }), () => jsonResponse(200, { status: "success" }));
    assert.deepEqual(await apiClient.get("/api/members"), { status: "success" });
    assert.equal(requests.at(-1).authorization, "Bearer kept");
});

test("a sleeping server (502/503) or no network while restoring is retried, with Connecting shown, until it answers", async () => {
    const answers = [new TypeError("Failed to fetch"), jsonResponse(503, {}), jsonResponse(502, {}), jsonResponse(200, { data: { access_token: "awake", expires_in: 3600 } })];
    serve(() => answers.shift());
    const waits = [];
    const session = await restoreAuthSessionWithRetry({ onWaiting: (attempt, error) => waits.push([attempt, error.status]), sleep: async () => {} });
    assert.equal(session.access_token, "awake");
    assert.deepEqual(waits, [[1, 0], [2, 503], [3, 502]]);
    assert.equal(signedOut, 0);
});

test("a rejected refresh (revoked, expired, signed out elsewhere) shows the sign-in screen at once, without retrying", async () => {
    serve(jsonResponse(401, { status: "error", message: "No saved session. Sign in again." }));
    const waits = [];
    assert.equal(await restoreAuthSessionWithRetry({ onWaiting: () => waits.push(1), sleep: async () => {} }), null);
    assert.deepEqual(waits, []);
    assert.equal(requests.length, 1);

    // The same from a timed refresh: only a 401 reaches the unauthorized handler.
    setAuthSession({ access_token: "doomed", expires_in: 3600 });
    serve(jsonResponse(401, { message: "Invalid Refresh Token" }), () => jsonResponse(401, { message: "Expired" }));
    await assert.rejects(apiClient.get("/api/members"), /Invalid Refresh Token/);
    assert.equal(signedOut, 1);
});

test("the retry gives up only after maxAttempts, and tells the difference between outages and rejections", async () => {
    serve(jsonResponse(503, { message: "Authentication service is unavailable." }));
    await assert.rejects(restoreAuthSessionWithRetry({ maxAttempts: 3, sleep: async () => {} }), /unavailable/);
    assert.equal(requests.length, 3);
    try {
        await restoreAuthSession();
    } catch (error) {
        assert.equal(isSessionRetryable(error), true);
    }
    serve(jsonResponse(401, {}));
    assert.equal(await restoreAuthSession(), null);
});

test("coming back to the app refreshes a token that ran out in the background, and leaves a fresh one alone", async () => {
    serve(jsonResponse(200, { data: { access_token: "renewed", expires_in: 3600 } }));
    setAuthSession({ access_token: "fresh", expires_in: 3600 });
    assert.equal(await ensureFreshSession(), null);
    assert.equal(requests.length, 0);

    setAuthSession({ access_token: "almost-gone", expires_in: 30 });
    const renewed = await ensureFreshSession();
    assert.equal(renewed.access_token, "renewed");
    assert.deepEqual(requests.map((request) => request.path), ["/api/auth/refresh"]);

    clearAuthSession();
    assert.equal(await ensureFreshSession(), null, "nothing to refresh when signed out");
});

test("signing out forgets the token so later requests carry none", async () => {
    setAuthSession({ access_token: "gone-soon", expires_in: 3600 });
    serve(jsonResponse(401, {}), () => jsonResponse(200, { status: "success" }));
    clearAuthSession();
    await apiClient.get("/api/public");
    assert.equal(requests.at(-1).authorization, "");
    assert.equal(await ensureFreshSession(), null);
});
