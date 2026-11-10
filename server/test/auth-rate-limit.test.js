import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createAuthRateLimit } from "../middleware/authRateLimit.js";

test("auth rate limiter allows ten requests per IP and blocks the eleventh", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.post("/auth", createAuthRateLimit(), (_request, response) => response.sendStatus(200));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    try {
        const baseUrl = `http://127.0.0.1:${server.address().port}/auth`;
        const responses = [];
        for (let index = 0; index < 11; index += 1) {
            responses.push(await fetch(baseUrl, { method: "POST" }));
        }
        assert.deepEqual(responses.slice(0, 10).map((response) => response.status), Array(10).fill(200));
        assert.equal(responses[10].status, 429);
        assert.equal(responses[10].headers.get("ratelimit-limit"), "10");
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
