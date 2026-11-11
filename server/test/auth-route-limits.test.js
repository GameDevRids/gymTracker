import test, { after, before } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.HOST = "127.0.0.1";
process.env.SUPABASE_URL = "https://your-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "your_service_role_key";
delete process.env.DEMO_PASSWORD;

const { app } = await import("../server.js");
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

// Invalid bodies are rejected by validation before any Supabase call, so these never reach the network.
async function post(path, ip) {
    return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({})
    });
}

for (const path of ["/api/auth/login", "/api/auth/refresh"]) {
    test(`${path} allows 10 requests per IP per 15 minutes, then returns a JSON 429`, async () => {
        const ip = path.endsWith("login") ? "203.0.113.10" : "203.0.113.20";
        const statuses = [];
        for (let index = 0; index < 10; index += 1) statuses.push((await post(path, ip)).status);
        assert.ok(statuses.every((status) => status !== 429), `unexpected 429 within limit: ${statuses}`);

        const limited = await post(path, ip);
        assert.equal(limited.status, 429);
        assert.equal(limited.headers.get("ratelimit-limit"), "10");
        assert.deepEqual(await limited.json(), {
            status: "error",
            message: "Too many sign-in attempts. Please wait 15 minutes and try again."
        });

        // The limit is per client IP, so another address is unaffected.
        assert.notEqual((await post(path, "203.0.113.99")).status, 429);
    });
}

test("the strict limit applies only to login and refresh, not other auth routes", async () => {
    const statuses = [];
    for (let index = 0; index < 12; index += 1) {
        const response = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { "X-Forwarded-For": "203.0.113.30" } });
        statuses.push(response.status);
    }
    assert.ok(statuses.every((status) => status !== 429), `logout was rate limited: ${statuses}`);
});
