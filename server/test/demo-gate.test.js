import test, { after, before } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.HOST = "127.0.0.1";
process.env.DEMO_PASSWORD = "demo-test-password";
process.env.SUPABASE_URL = "https://your-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "your_service_role_key";

const { app } = await import("../server.js");
const { createDemoCookieValue, isValidDemoCookie, requireDemoAuth, DEMO_COOKIE_MAX_AGE_SECONDS } = await import("../middleware/demoAuth.js");
const basic = (credentials) => `Basic ${Buffer.from(credentials).toString("base64")}`;
let server;
let baseUrl;

before(async () => {
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

test("demo password protects every route except /health with HTTP Basic Auth", async () => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const unauthorized = await fetch(baseUrl);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("www-authenticate"), 'Basic realm="GymPulse Demo"');
    assert.deepEqual(await unauthorized.json(), { error: "Demo password required." });

    const invalid = await fetch(`${baseUrl}/assets/js/main.js`, {
        headers: { Authorization: `Basic ${Buffer.from("demo:wrong-password").toString("base64")}` }
    });
    assert.equal(invalid.status, 401);

    const authorized = await fetch(baseUrl, {
        headers: { Authorization: `Basic ${Buffer.from("demo:demo-test-password").toString("base64")}` }
    });
    assert.equal(authorized.status, 200);
});

test("a successful Basic login sets a signed HttpOnly cookie that lets bearer-token API calls through", async () => {
    const login = await fetch(baseUrl, { headers: { Authorization: basic("demo:demo-test-password") } });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie");
    assert.match(setCookie, /^gympulse_demo=\d+\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax$/);
    const cookie = setCookie.split(";")[0];

    // The app's own Authorization header replaces Basic credentials; the cookie must carry the gate.
    // A static file is used so the request passes the gate without needing a live Supabase project.
    const withBearer = await fetch(`${baseUrl}/assets/js/main.js`, { headers: { Cookie: cookie, Authorization: "Bearer app-access-token" } });
    assert.equal(withBearer.status, 200);
    assert.equal(withBearer.headers.get("set-cookie"), null);
});

test("bearer tokens, tampered cookies and missing usernames do not bypass the demo gate", async () => {
    const bearerOnly = await fetch(`${baseUrl}/api/members`, { headers: { Authorization: "Bearer anything" } });
    assert.equal(bearerOnly.status, 401);
    assert.deepEqual(await bearerOnly.json(), { error: "Demo password required." });

    const forged = createDemoCookieValue("some-other-password");
    const tampered = await fetch(baseUrl, { headers: { Cookie: `gympulse_demo=${forged}` } });
    assert.equal(tampered.status, 401);

    const noUsername = await fetch(baseUrl, { headers: { Authorization: basic(":demo-test-password") } });
    assert.equal(noUsername.status, 401);

    const dbHealth = await fetch(`${baseUrl}/health/db`);
    assert.equal(dbHealth.status, 401);
});

test("the demo cookie is marked Secure behind an HTTPS proxy", async () => {
    const response = await fetch(baseUrl, {
        headers: { Authorization: basic("demo:demo-test-password"), "X-Forwarded-Proto": "https" }
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /; Secure$/);
});

test("demo cookies expire and are bound to the current password", () => {
    const issuedAt = Date.UTC(2026, 10, 11);
    const value = createDemoCookieValue("pw", issuedAt);
    assert.equal(isValidDemoCookie(value, "pw", issuedAt + 1000), true);
    assert.equal(isValidDemoCookie(value, "pw", issuedAt + DEMO_COOKIE_MAX_AGE_SECONDS * 1000), false);
    assert.equal(isValidDemoCookie(value, "changed-password", issuedAt + 1000), false);
    assert.equal(isValidDemoCookie("garbage", "pw", issuedAt), false);
});

test("the demo gate is disabled when no password is configured", () => {
    let passed = false;
    requireDemoAuth("")({ path: "/", get: () => "" }, {}, () => { passed = true; });
    assert.equal(passed, true);
});
