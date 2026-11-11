import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createAuthRouter } from "../routes/auth.js";

const REFRESH_TOKEN = "refresh-token-value-at-least-twenty";
const ROTATED_TOKEN = "rotated-refresh-token-value-0001";
const calls = [];
const behaviour = {};
const authError = (status, message) => Object.assign(new Error(message), { status });

// A fake Supabase auth service; each test sets how it behaves.
const fakeService = {
    async login(credentials) {
        calls.push(["login", credentials.email]);
        return { access_token: "access-1", refresh_token: REFRESH_TOKEN, expires_in: 3600, user: { id: "u1" }, gym: null };
    },
    async refresh(token) {
        calls.push(["refresh", token]);
        if (behaviour.refreshError) throw behaviour.refreshError;
        return { access_token: "access-2", refresh_token: ROTATED_TOKEN, expires_in: 3600, user: { id: "u1" }, gym: null };
    },
    async logout(token) {
        calls.push(["logout", token]);
        if (behaviour.logoutFailsFor === token) throw authError(503, "The session could not be revoked.");
    },
    async createGym() { return {}; }
};

let server;
let baseUrl;

before(async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use("/api/auth", createAuthRouter(fakeService));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
    calls.length = 0;
    delete behaviour.refreshError;
    delete behaviour.logoutFailsFor;
});

function post(path, { cookie, bearer, origin, body, headers = {} } = {}) {
    return fetch(`${baseUrl}/api/auth/${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: `gympulse_refresh=${encodeURIComponent(cookie)}` } : {}),
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            ...(origin ? { Origin: origin } : {}),
            ...headers
        },
        body: JSON.stringify(body ?? {})
    });
}

test("login stores the refresh token in an HttpOnly session cookie and leaves it out of the response", async () => {
    const response = await post("login", { body: { email: "owner@example.com", password: "secret" }, origin: baseUrl });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), `gympulse_refresh=${REFRESH_TOKEN}; Path=/api/auth; HttpOnly; SameSite=Strict`);
    const body = await response.json();
    assert.equal(body.data.access_token, "access-1");
    assert.equal(Object.hasOwn(body.data, "refresh_token"), false);
});

test("refresh reads only the cookie, rotates it, and never returns the refresh token", async () => {
    const response = await post("refresh", { cookie: REFRESH_TOKEN, body: { refresh_token: "ignored-body-token-value-123" } });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["refresh", REFRESH_TOKEN]]);
    assert.match(response.headers.get("set-cookie"), new RegExp(`^gympulse_refresh=${ROTATED_TOKEN}; Path=/api/auth; HttpOnly; SameSite=Strict$`));
    const body = await response.json();
    assert.equal(body.data.access_token, "access-2");
    assert.equal(Object.hasOwn(body.data, "refresh_token"), false);
});

test("refresh without a cookie is a 401 that never calls Supabase, even with a token in the body", async () => {
    const response = await post("refresh", { body: { refresh_token: REFRESH_TOKEN } });
    assert.equal(response.status, 401);
    assert.deepEqual(calls, []);
});

test("a rejected refresh token clears the cookie, but an outage keeps it for a retry", async () => {
    behaviour.refreshError = authError(401, "Invalid Refresh Token");
    const rejected = await post("refresh", { cookie: REFRESH_TOKEN });
    assert.equal(rejected.status, 401);
    assert.match(rejected.headers.get("set-cookie"), /^gympulse_refresh=; Path=\/api\/auth; HttpOnly; SameSite=Strict; Max-Age=0$/);

    behaviour.refreshError = authError(503, "Authentication service is unavailable.");
    const outage = await post("refresh", { cookie: REFRESH_TOKEN });
    assert.equal(outage.status, 503);
    assert.equal(outage.headers.get("set-cookie"), null);
});

test("cross-site requests to login, refresh and logout are rejected", async () => {
    for (const path of ["login", "refresh", "logout"]) {
        const byOrigin = await post(path, { cookie: REFRESH_TOKEN, origin: "https://evil.example" });
        assert.equal(byOrigin.status, 403, path);
        const byFetchSite = await post(path, { cookie: REFRESH_TOKEN, headers: { "Sec-Fetch-Site": "cross-site" } });
        assert.equal(byFetchSite.status, 403, path);
    }
    assert.deepEqual(calls, []);

    const sameOrigin = await post("refresh", { cookie: REFRESH_TOKEN, origin: baseUrl, headers: { "Sec-Fetch-Site": "same-origin" } });
    assert.equal(sameOrigin.status, 200);
});

test("logout revokes with the access token and always clears the cookie", async () => {
    const response = await post("logout", { cookie: REFRESH_TOKEN, bearer: "access-1" });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["logout", "access-1"]]);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0$/);
});

test("logout with an expired access token revokes through the refresh cookie", async () => {
    behaviour.logoutFailsFor = "expired-access";
    const response = await post("logout", { cookie: REFRESH_TOKEN, bearer: "expired-access" });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["logout", "expired-access"], ["refresh", REFRESH_TOKEN], ["logout", "access-2"]]);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0$/);
});

test("logout reports a failed revocation but still clears the cookie", async () => {
    behaviour.logoutFailsFor = "access-1";
    const response = await post("logout", { bearer: "access-1" });
    assert.equal(response.status, 503);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0$/);
});

test("logout succeeds when nothing is left to revoke", async () => {
    const empty = await post("logout");
    assert.equal(empty.status, 200);
    assert.deepEqual(calls, []);

    behaviour.refreshError = authError(401, "Invalid Refresh Token");
    const staleCookie = await post("logout", { cookie: REFRESH_TOKEN });
    assert.equal(staleCookie.status, 200);
    assert.deepEqual(calls, [["refresh", REFRESH_TOKEN]]);
});

test("the refresh cookie is marked Secure behind an HTTPS proxy", async () => {
    const response = await post("refresh", { cookie: REFRESH_TOKEN, headers: { "X-Forwarded-Proto": "https" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /; Secure$/);
});
