import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import pino from "pino";
import { logRedaction, serializeRequest } from "../config/logger.js";

test("HTTP request logs redact authorization, phone headers, and query values", () => {
    const serialized = serializeRequest({
        id: 1,
        method: "GET",
        url: "/api/members?search=9876543210",
        headers: {
            authorization: "Bearer secret",
            cookie: "gympulse_demo=signed-value",
            "x-whatsapp-to": "9876543210",
            accept: "application/json"
        }
    });

    assert.deepEqual(serialized, {
        id: 1,
        method: "GET",
        url: "/api/members",
        headers: {
            authorization: "[REDACTED]",
            cookie: "[REDACTED]",
            "x-whatsapp-to": "[REDACTED]",
            accept: "application/json"
        }
    });
});

test("log redaction hides request cookies and the demo gate's Set-Cookie response header", () => {
    const lines = [];
    const sink = new Writable({ write(chunk, _encoding, done) { lines.push(chunk.toString()); done(); } });
    const logger = pino({ redact: logRedaction }, sink);
    logger.info({
        req: { headers: { cookie: "gympulse_demo=signed-value", authorization: "Basic abc" } },
        res: { headers: { "set-cookie": "gympulse_demo=signed-value; HttpOnly" } }
    }, "request completed");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.req.headers.cookie, "[REDACTED]");
    assert.equal(entry.req.headers.authorization, "[REDACTED]");
    assert.equal(entry.res.headers["set-cookie"], "[REDACTED]");
    assert.doesNotMatch(lines[0], /signed-value/);
});
