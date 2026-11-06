import test from "node:test";
import assert from "node:assert/strict";
import { createMember, updateMember } from "../services/membersService.js";

function mockSupabase(result) {
    const calls = [];
    const client = {
        from(table) {
            const query = {
                insert(record) {
                    calls.push({ operation: "insert", table, record });
                    return this;
                },
                update(record) {
                    calls.push({ operation: "update", table, record });
                    return this;
                },
                eq(field, value) {
                    calls.push({ operation: "eq", table, field, value });
                    return this;
                },
                select(columns) {
                    calls.push({ operation: "select", table, columns });
                    return this;
                },
                single() {
                    return Promise.resolve({ data: result, error: null });
                },
                maybeSingle() {
                    return Promise.resolve({ data: result, error: null });
                }
            };
            return query;
        }
    };
    return { client, calls };
}

function mockSupabaseError(error) {
    const calls = [];
    const client = {
        from(table) {
            const query = {
                insert(record) {
                    calls.push({ operation: "insert", table, record });
                    return this;
                },
                select(columns) {
                    calls.push({ operation: "select", table, columns });
                    return this;
                },
                single() {
                    return Promise.resolve({ data: null, error });
                }
            };
            return query;
        }
    };
    return { client, calls };
}

const member = {
    full_name: "Test Member",
    phone: "9876543210",
    membership_start_date: "2026-01-01",
    membership_end_date: "2026-01-30"
};

test("member creation service excludes membership dates from inserted records", async () => {
    const mock = mockSupabase({ id: "member-id", ...member });
    await createMember(member, mock.client);

    const insert = mock.calls.find((call) => call.operation === "insert");
    assert.ok(insert);
    assert.equal(Object.hasOwn(insert.record, "membership_start_date"), false);
    assert.equal(Object.hasOwn(insert.record, "membership_end_date"), false);
    assert.equal(insert.record.full_name, member.full_name);
});

test("member update service excludes membership dates from updates", async () => {
    const mock = mockSupabase({ id: "member-id", ...member });
    await updateMember("member-id", {
        full_name: "Updated Member",
        membership_start_date: "2026-02-01",
        membership_end_date: "2026-03-01"
    }, mock.client);

    const update = mock.calls.find((call) => call.operation === "update");
    assert.ok(update);
    assert.equal(Object.hasOwn(update.record, "membership_start_date"), false);
    assert.equal(Object.hasOwn(update.record, "membership_end_date"), false);
    assert.equal(update.record.full_name, "Updated Member");
});

test("member update with only membership dates performs no database update", async () => {
    const mock = mockSupabase(null);
    await assert.rejects(
        updateMember("member-id", {
            membership_start_date: "2026-02-01",
            membership_end_date: "2026-03-01"
        }, mock.client),
        (error) => error.status === 400
    );
    assert.equal(mock.calls.length, 0);
});

test("member creation reports that migration 004 is required when legacy dates are still NOT NULL", async () => {
    const mock = mockSupabaseError({ code: "23502" });
    await assert.rejects(
        createMember(member, mock.client),
        (error) => error.status === 503 && error.message.includes("004_create_member_memberships.sql")
    );
    assert.equal(mock.calls.filter((call) => call.operation === "insert").length, 1);
});
