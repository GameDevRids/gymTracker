import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createAuthRouter } from "../routes/auth.js";
import { changePassword, requestPasswordReset, resetPassword } from "../services/authService.js";
import { passwordProblem, readRecoveryLink } from "../../assets/js/passwordRules.js";

process.env.SUPABASE_URL = "https://gympulse-auth.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "server-only-test-key";

const RESET_TOKEN = "eyJhbGciOiJIUzI1NiJ9.recovery-token.signature";
const user = { id: "00000000-0000-4000-8000-000000000001", email: "owner@example.test" };

// ---------- Password rules (shared by the browser and the server) ----------

test("passwordProblem accepts 8+ characters that match, and explains every other case", () => {
    assert.equal(passwordProblem("long enough", "long enough"), "");
    assert.match(passwordProblem("short", "short"), /at least 8/);
    assert.match(passwordProblem("a".repeat(73), "a".repeat(73)), /shorter/);
    // 24 Devanagari letters are 72 bytes; 25 are 75 (bcrypt only uses 72).
    assert.equal(passwordProblem("क".repeat(24)), "");
    assert.match(passwordProblem("क".repeat(25)), /shorter/);
    assert.match(passwordProblem(" leading space"), /space/);
    assert.match(passwordProblem("trailing space "), /space/);
    assert.match(passwordProblem("password-one", "password-two"), /not the same/);
});

test("readRecoveryLink reads the token from Supabase's redirect, or why there is none", () => {
    assert.deepEqual(readRecoveryLink(`#access_token=${RESET_TOKEN}&type=recovery&expires_in=3600`), { accessToken: RESET_TOKEN, error: "" });
    assert.deepEqual(readRecoveryLink("#access_token=abc&type=signup"), { accessToken: "", error: "missing" });
    assert.deepEqual(readRecoveryLink("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired"),
        { accessToken: "", error: "expired" });
    assert.deepEqual(readRecoveryLink("", "?error=server_error"), { accessToken: "", error: "failed" });
    assert.deepEqual(readRecoveryLink("", ""), { accessToken: "", error: "missing" });
});

// ---------- Routes, with a fake auth service ----------

const calls = [];
const fakeService = {
    async requestPasswordReset(email, redirectTo) { calls.push(["forgot", email, redirectTo]); },
    async resetPassword(token, password) {
        calls.push(["reset", token, password]);
        if (token === "expired-token-from-an-old-email") throw Object.assign(new Error("This reset link has expired or was already used. Ask for a new one."), { status: 401 });
    }
};

let server;
let baseUrl;

before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/auth", createAuthRouter(fakeService));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function post(path, body, headers = {}) {
    return fetch(`${baseUrl}/api/auth${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body)
    });
}

test("forgot-password answers the same for any email and links back to /reset-password", async () => {
    calls.length = 0;
    const response = await post("/forgot-password", { email: "  Someone@Example.test " });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.message, /If an account uses that email/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "forgot");
    assert.match(calls[0][1], /^someone@example\.test$/i);
    assert.match(calls[0][2], /\/reset-password$/);
});

test("forgot-password rejects a missing email and cross-site requests before calling Supabase", async () => {
    calls.length = 0;
    assert.equal((await post("/forgot-password", {})).status, 400);
    assert.equal((await post("/forgot-password", { email: "a@b.test" }, { Origin: "https://evil.example" })).status, 403);
    assert.equal(calls.length, 0);
});

test("reset-password checks the new password, sets it, and clears this browser's sign-in cookie", async () => {
    calls.length = 0;
    const weak = await post("/reset-password", { access_token: RESET_TOKEN, password: "short", confirm_password: "short" });
    assert.equal(weak.status, 400);
    assert.match((await weak.json()).message, /at least 8/);
    const mismatch = await post("/reset-password", { access_token: RESET_TOKEN, password: "new-password-1", confirm_password: "new-password-2" });
    assert.equal(mismatch.status, 400);
    assert.equal(calls.length, 0);

    const response = await post("/reset-password", { access_token: RESET_TOKEN, password: "new-password-1", confirm_password: "new-password-1" });
    assert.equal(response.status, 200);
    assert.match((await response.json()).message, /Sign in with the new password/);
    assert.ok(response.headers.get("set-cookie"), "the refresh cookie is cleared");
    assert.deepEqual(calls, [["reset", RESET_TOKEN, "new-password-1"]]);
});

test("reset-password passes on an expired link's message", async () => {
    const response = await post("/reset-password", { access_token: "expired-token-from-an-old-email", password: "new-password-1", confirm_password: "new-password-1" });
    assert.equal(response.status, 401);
    assert.match((await response.json()).message, /expired or was already used/);
});

// ---------- authService, with Supabase's REST API stubbed ----------

function stubFetch(handler) {
    const original = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        const request = { url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : undefined, auth: options.headers?.Authorization };
        requests.push(request);
        const [status, data] = handler(request);
        return { ok: status < 400, status, json: async () => data };
    };
    return { requests, restore: () => { globalThis.fetch = original; } };
}

const fakeDb = {
    from() {
        return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }) };
    }
};

test("requestPasswordReset sends the redirect, hides unknown emails and reports rate limits", async () => {
    let answer = [200, {}];
    const fetchStub = stubFetch(() => answer);
    try {
        await requestPasswordReset("owner@example.test", "https://app.example/reset-password", fakeDb);
        assert.match(fetchStub.requests[0].url, /\/auth\/v1\/recover\?redirect_to=https%3A%2F%2Fapp\.example%2Freset-password$/);
        assert.deepEqual(fetchStub.requests[0].body, { email: "owner@example.test" });
        answer = [404, { error_code: "user_not_found" }];
        await requestPasswordReset("nobody@example.test", "https://app.example/reset-password", fakeDb);
        answer = [429, { error_code: "over_email_send_rate_limit" }];
        await assert.rejects(requestPasswordReset("owner@example.test", "x", fakeDb), { status: 429 });
        answer = [500, {}];
        await assert.rejects(requestPasswordReset("owner@example.test", "x", fakeDb), { status: 503 });
    } finally {
        fetchStub.restore();
    }
});

test("resetPassword sets the password with the link's token and signs out every device", async () => {
    const fetchStub = stubFetch(() => [200, {}]);
    try {
        await resetPassword(RESET_TOKEN, "new-password-1", fakeDb);
        assert.equal(fetchStub.requests[0].method, "PUT");
        assert.match(fetchStub.requests[0].url, /\/auth\/v1\/user$/);
        assert.deepEqual(fetchStub.requests[0].body, { password: "new-password-1" });
        assert.equal(fetchStub.requests[0].auth, `Bearer ${RESET_TOKEN}`);
        assert.match(fetchStub.requests[1].url, /logout\?scope=global$/);
    } finally {
        fetchStub.restore();
    }
});

test("resetPassword explains an expired link and a reused password", async () => {
    let answer = [401, { error_code: "bad_jwt" }];
    const fetchStub = stubFetch(() => answer);
    try {
        await assert.rejects(resetPassword("old", "new-password-1", fakeDb), { status: 401, message: /expired or was already used/ });
        answer = [422, { error_code: "same_password", msg: "New password should be different from the old password." }];
        await assert.rejects(resetPassword("t", "new-password-1", fakeDb), { status: 400, message: /different from your old one/ });
    } finally {
        fetchStub.restore();
    }
});

test("changePassword checks the current password first, then signs out only other devices", async () => {
    const fetchStub = stubFetch((request) => {
        if (request.url.includes("grant_type=password")) {
            return request.body.password === "current-pass"
                ? [200, { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600, user }]
                : [400, { error_code: "invalid_credentials" }];
        }
        return [200, {}];
    });
    try {
        await assert.rejects(changePassword(user.email, "wrong-pass", "new-password-1", fakeDb), { status: 400, message: /current password is not right/ });
        assert.equal(fetchStub.requests.length, 1, "nothing is changed after a wrong current password");

        fetchStub.requests.length = 0;
        const session = await changePassword(user.email, "current-pass", "new-password-1", fakeDb);
        assert.equal(session.access_token, "fresh-access");
        assert.equal(session.refresh_token, "fresh-refresh");
        const [, update, logout] = fetchStub.requests;
        assert.equal(update.method, "PUT");
        assert.equal(update.auth, "Bearer fresh-access");
        assert.deepEqual(update.body, { password: "new-password-1" });
        assert.match(logout.url, /logout\?scope=others$/);
    } finally {
        fetchStub.restore();
    }
});
