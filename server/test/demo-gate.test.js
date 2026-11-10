import test, { after, before } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.HOST = "127.0.0.1";
process.env.DEMO_PASSWORD = "demo-test-password";

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
