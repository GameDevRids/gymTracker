import test from "node:test";
import assert from "node:assert/strict";
import { serializeRequest } from "../config/logger.js";

test("HTTP request logs redact authorization, phone headers, and query values", () => {
    const serialized = serializeRequest({
        id: 1,
        method: "GET",
        url: "/api/members?search=9876543210",
        headers: {
            authorization: "Bearer secret",
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
            "x-whatsapp-to": "[REDACTED]",
            accept: "application/json"
        }
    });
});
