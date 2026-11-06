import test from "node:test";
import assert from "node:assert/strict";
import { getServiceRoleKeyError } from "../config/database.js";

function jwtWithRole(role) {
    const payload = Buffer.from(JSON.stringify({ role })).toString("base64url");
    return `header.${payload}.signature`;
}

test("Supabase secret keys are accepted for backend use", () => {
    assert.equal(getServiceRoleKeyError("sb_secret_example"), null);
});

test("legacy service-role JWTs are accepted for backend use", () => {
    assert.equal(getServiceRoleKeyError(jwtWithRole("service_role")), null);
});

test("publishable and anon keys are rejected as service-role credentials", () => {
    assert.match(getServiceRoleKeyError("sb_publishable_example"), /publishable key/);
    assert.match(getServiceRoleKeyError(jwtWithRole("anon")), /anon key/);
});

test("missing and unrecognized credentials are rejected", () => {
    assert.match(getServiceRoleKeyError(""), /missing/);
    assert.match(getServiceRoleKeyError("not-a-supabase-key"), /service_role JWT/);
});
