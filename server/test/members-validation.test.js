import test from "node:test";
import assert from "node:assert/strict";
import {
    validateMemberId,
    validateMemberListQuery,
    validateMemberPayload
} from "../middleware/validateMember.js";

function invoke(middleware, values = {}) {
    const request = { ...values };
    const response = {
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
    let nextCalled = false;
    middleware(request, response, () => { nextCalled = true; });
    return { request, response, nextCalled };
}

const validMember = {
    full_name: "Fictional Test Member",
    phone: "9876543210"
};

test("valid member creation payload is normalized", () => {
    const result = invoke(validateMemberPayload("create"), { body: { ...validMember, full_name: "  Fictional Test Member  " } });
    assert.equal(result.nextCalled, true);
    assert.equal(result.request.validatedMember.full_name, "Fictional Test Member");
});

test("member creation requires full name and phone only", () => {
    for (const body of [
        { phone: validMember.phone },
        { full_name: validMember.full_name }
    ]) {
        const result = invoke(validateMemberPayload("create"), { body });
        assert.equal(result.nextCalled, false);
        assert.equal(result.response.statusCode, 400);
    }
});

test("phone number must contain exactly 10 numeric digits", () => {
    const accepted = invoke(validateMemberPayload("create"), { body: { ...validMember, phone: "9876543210" } });
    assert.equal(accepted.nextCalled, true);
    assert.equal(accepted.request.validatedMember.phone, "9876543210");

    for (const phone of ["987654321", "98765432101", "98765abc10", "98765 43210", "+9876543210"]) {
        const rejected = invoke(validateMemberPayload("create"), { body: { ...validMember, phone } });
        assert.equal(rejected.nextCalled, false, `${phone} should be rejected`);
        assert.equal(rejected.response.statusCode, 400);
        assert.equal(rejected.response.body.message, "Phone number must contain exactly 10 digits.");
    }
});

test("optional email and date fields are validated", () => {
    for (const body of [
        { ...validMember, email: "not-an-email" },
        { ...validMember, date_of_birth: "2025-02-30" }
    ]) {
        const result = invoke(validateMemberPayload("create"), { body });
        assert.equal(result.response.statusCode, 400);
    }
});

test("membership dates are rejected by normal member create and update requests", () => {
    for (const mode of ["create", "update"]) {
        for (const field of ["membership_start_date", "membership_end_date"]) {
            const result = invoke(validateMemberPayload(mode), {
                body: { ...validMember, [field]: "2026-01-01" }
            });
            assert.equal(result.nextCalled, false);
            assert.equal(result.response.statusCode, 400);
            assert.equal(result.response.body.message, "Membership dates must be managed through the membership assignment system.");
        }
    }
});

test("status is restricted to the database-supported values", () => {
    const result = invoke(validateMemberPayload("create"), { body: { ...validMember, status: "expired" } });
    assert.equal(result.response.statusCode, 400);
});

test("protected and unsupported fields are rejected", () => {
    const result = invoke(validateMemberPayload("create"), { body: { ...validMember, id: "client-controlled" } });
    assert.equal(result.response.statusCode, 400);
});

test("update requires at least one permitted field", () => {
    const result = invoke(validateMemberPayload("update"), { body: {} });
    assert.equal(result.response.statusCode, 400);
});

test("member IDs must be UUIDs", () => {
    const invalid = invoke(validateMemberId, { params: { id: "not-a-uuid" } });
    const valid = invoke(validateMemberId, { params: { id: "00000000-0000-4000-8000-000000000001" } });
    assert.equal(invalid.response.statusCode, 400);
    assert.equal(valid.nextCalled, true);
});

test("member list pagination and status are validated", () => {
    const invalidPage = invoke(validateMemberListQuery, { query: { page: "0" } });
    const invalidLimit = invoke(validateMemberListQuery, { query: { limit: "101" } });
    const invalidStatus = invoke(validateMemberListQuery, { query: { status: "expired" } });
    const valid = invoke(validateMemberListQuery, { query: { page: "2", limit: "10", status: "active", search: "Taylor" } });
    assert.equal(invalidPage.response.statusCode, 400);
    assert.equal(invalidLimit.response.statusCode, 400);
    assert.equal(invalidStatus.response.statusCode, 400);
    assert.equal(valid.nextCalled, true);
    assert.deepEqual(valid.request.memberListQuery, { page: 2, limit: 10, status: "active", search: "Taylor" });
});
