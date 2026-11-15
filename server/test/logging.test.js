import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import pino from "pino";
import { logRedaction, serializeError, serializeRequest, serializeResponse } from "../config/logger.js";
import { maskPath, scrubText, scrubValue } from "../config/scrub.js";

test("HTTP request logs keep only the method and a masked path: no headers, IP or query", () => {
    const serialized = serializeRequest({
        id: 1,
        method: "GET",
        url: "/api/members/3f1c2a9e-1b2c-4d5e-8f90-123456789abc/photo?search=9876543210",
        remoteAddress: "203.0.113.5",
        headers: {
            authorization: "Bearer secret",
            cookie: "gympulse_demo=signed-value",
            "x-whatsapp-to": "9876543210"
        }
    });
    assert.deepEqual(serialized, { id: 1, method: "GET", path: "/api/members/:id/photo" });
    assert.deepEqual(serializeResponse({ statusCode: 201, headers: { "set-cookie": "x" } }), { statusCode: 201 });
});

test("log redaction hides headers, cookies and personal fields if a log call passes them", () => {
    const lines = [];
    const sink = new Writable({ write(chunk, _encoding, done) { lines.push(chunk.toString()); done(); } });
    const logger = pino({ redact: logRedaction }, sink);
    logger.info({
        req: { headers: { cookie: "gympulse_demo=signed-value", authorization: "Basic abc" }, body: { phone: "9876543210" } },
        res: { headers: { "set-cookie": "gympulse_demo=signed-value; HttpOnly" } },
        member: { phone: "9876543210", email: "owner@example.com" }
    }, "request completed");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.req.headers, "[REDACTED]");
    assert.equal(entry.req.body, "[REDACTED]");
    assert.equal(entry.res.headers, "[REDACTED]");
    assert.equal(entry.member.phone, "[REDACTED]");
    assert.equal(entry.member.email, "[REDACTED]");
    assert.doesNotMatch(lines[0], /signed-value|9876543210|owner@example/);
});

test("maskPath replaces ids, tokens, phone numbers and emails in path segments", () => {
    assert.equal(maskPath("/c/abcdefghijklmnopqrstuvwxyz123456"), "/c/:token");
    assert.equal(maskPath("/api/lookup/+919876543210"), "/api/lookup/:number");
    assert.equal(maskPath("/api/invite/owner%40example.com"), "/api/invite/:email");
    assert.equal(maskPath("/api/members?page=2#top"), "/api/members");
    assert.equal(maskPath(""), "/");
});

test("scrubText removes phones, emails, tokens and Postgres values but keeps the message readable", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl";
    const text = scrubText(`Failed for owner@example.com +91 98765 43210 with Bearer abc.def ${jwt} `
        + "Key (gym_id, phone)=(g1, 9876543210) already exists");
    assert.doesNotMatch(text, /owner@example|98765|abc\.def|eyJ|g1, /);
    assert.match(text, /^Failed for \[email\] \[phone\] with Bearer \[token\] \[token\]/);
    assert.match(text, /\)=\(\[removed\]\) already exists$/);
    assert.equal(scrubText("Cannot read properties of undefined (reading 'name')"),
        "Cannot read properties of undefined (reading 'name')");
    assert.equal(scrubText('Member "Ravi Kumar" not found', { quotes: true }), "Member [text] not found");
    assert.equal(scrubText(null), null);
});

test("scrubValue scrubs strings nested in objects and arrays", () => {
    assert.deepEqual(scrubValue({ a: ["call 9876543210"], b: { c: "x@y.io" }, n: 5 }),
        { a: ["call [phone]"], b: { c: "[email]" }, n: 5 });
});

test("serializeError keeps type, code and status and scrubs the message and stack", () => {
    const error = new TypeError("lookup failed for 9876543210");
    error.code = "23505";
    error.status = 409;
    error.details = "Key (phone)=(9876543210) already exists.";
    const serialized = serializeError(error);
    assert.equal(serialized.type, "TypeError");
    assert.equal(serialized.code, "23505");
    assert.equal(serialized.status, 409);
    assert.equal(serialized.message, "lookup failed for [phone]");
    assert.doesNotMatch(JSON.stringify(serialized), /9876543210/);
});
