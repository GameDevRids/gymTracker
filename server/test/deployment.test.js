import test, { after, before } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.HOST = "127.0.0.1";
process.env.SUPABASE_URL = "https://your-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "your_service_role_key";

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
    if (server) {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test("frontend shell is public while protected member APIs require a bearer token", async () => {
    const frontend = await fetch(baseUrl);
    assert.equal(frontend.status, 200);
    assert.match(await frontend.text(), /GymPulse/);

    const unauthorized = await fetch(`${baseUrl}/api/members`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { status: "error", message: "Authentication required." });
});

test("auth input is validated and WhatsApp webhook verification remains public", async () => {
    const invalidLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "not-an-email", password: "" })
    });
    assert.equal(invalidLogin.status, 400);

    const webhook = await fetch(`${baseUrl}/api/whatsapp/webhook`);
    assert.notEqual(webhook.status, 401);
});

test("health remains open and returns its quick status response", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
});

test("the database health check does not expose errors", async () => {
    const response = await fetch(`${baseUrl}/health/db`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "error", message: "Database unavailable." });
});

test("expiring membership API requires authentication", async () => {
    const response = await fetch(`${baseUrl}/api/memberships/expiring?days=8`);
    assert.equal(response.status, 401);
});

test("frontend HTML and static assets load with the expected content security policy", async () => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    const policy = response.headers.get("content-security-policy");
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /'unsafe-inline'/);
    assert.match(policy, /https:\/\/fonts\.googleapis\.com/);

    const html = await response.text();
    assert.match(html, /src="\/assets\/vendor\/chart\.umd\.min\.js"/);
    assert.equal((await fetch(`${baseUrl}/assets/js/main.js`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/assets/css/styles.css`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/assets/vendor/chart.umd.min.js`)).status, 200);

    const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.name, "GymPulse");
    assert.equal(manifest.display, "standalone");
    assert.equal((await fetch(`${baseUrl}/index.html`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/sw.js`)).headers.get("service-worker-allowed"), "/");
    const workerResponse = await fetch(`${baseUrl}/sw.js`);
    assert.equal(workerResponse.status, 200);
    const workerSource = await workerResponse.text();
    assert.match(workerSource, /gympulse-shell-v8/);
    assert.match(workerSource, /fetch\(new Request\(request, \{ cache: "no-cache" \}\)\)[\s\S]*?cache\.put\(url\.pathname, copy\)/);
    assert.equal((await fetch(`${baseUrl}/assets/icons/gympulse-192.png`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/assets/icons/gympulse-512.png`)).status, 200);
});

test("the service worker pre-caches every frontend module so the app can start offline", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join, relative, sep } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const projectDir = fileURLToPath(new URL("../../", import.meta.url));
    const worker = readFileSync(join(projectDir, "sw.js"), "utf8");
    const listed = new Set([...worker.matchAll(/"(\/assets\/js\/[^"]+\.js)"/g)].map((match) => match[1]));
    const root = join(projectDir, "assets", "js");
    const modules = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith(".js")) modules.push(`/assets/js/${relative(root, path).split(sep).join("/")}`);
        }
    };
    walk(root);
    assert.ok(modules.length > 10);
    assert.deepEqual(modules.filter((path) => !listed.has(path)), []);
});
