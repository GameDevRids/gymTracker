import test from "node:test";
import assert from "node:assert/strict";
import { createMember, deleteMember, getMember, listMembers, memberBilling, updateMember } from "../services/membersService.js";

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
                is(field, value) {
                    calls.push({ operation: "is", table, field, value });
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

function mockMembershipReads(members, memberships, payments = []) {
    const calls = [];
    const client = {
        from(table) {
            const call = { table, operations: [] };
            calls.push(call);
            const query = {};
            for (const method of ["select", "order", "range", "eq", "or", "in", "is", "update"]) {
                query[method] = (...args) => {
                    call.operations.push([method, ...args]);
                    return query;
                };
            }
            query.maybeSingle = () => Promise.resolve({
                data: table === "members" ? members[0] || null : memberships[0] || null,
                error: null
            });
            query.then = (resolve, reject) => Promise.resolve({
                data: table === "members" ? members : table === "payments" ? payments : memberships,
                count: members.length,
                error: null
            }).then(resolve, reject);
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
const gymId = "00000000-0000-4000-8000-000000000099";

test("member creation service excludes membership dates from inserted records", async () => {
    const mock = mockSupabase({ id: "member-id", ...member });
    await createMember(member, gymId, mock.client);

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
    }, gymId, mock.client);

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
        }, gymId, mock.client),
        (error) => error.status === 400
    );
    assert.equal(mock.calls.length, 0);
});

test("member creation reports that migration 004 is required when legacy dates are still NOT NULL", async () => {
    const mock = mockSupabaseError({ code: "23502" });
    await assert.rejects(
        createMember(member, gymId, mock.client),
        (error) => error.status === 503 && error.message.includes("004_create_member_memberships.sql")
    );
    assert.equal(mock.calls.filter((call) => call.operation === "insert").length, 1);
});

test("member list attaches current membership from one batched history query", async () => {
    const memberRows = [
        { id: "active-member", full_name: "Active", status: "active" },
        { id: "upcoming-member", full_name: "Upcoming", status: "active" },
        { id: "expired-member", full_name: "Expired", status: "active" },
        { id: "cancelled-member", full_name: "Cancelled", status: "active" },
        { id: "unassigned-member", full_name: "Unassigned", status: "active" }
    ];
    const historyRows = [
        { id: "membership-active", member_id: "active-member", plan_name: "Monthly", status: "assigned", start_date: "2000-01-01", end_date: "2099-01-30", created_at: "2026-11-01" },
        { id: "membership-upcoming", member_id: "upcoming-member", status: "assigned", start_date: "2099-02-01", end_date: "2099-03-02", created_at: "2026-11-01" },
        { id: "membership-expired", member_id: "expired-member", status: "assigned", start_date: "2000-10-01", end_date: "2000-10-30", created_at: "2026-10-01" },
        { id: "membership-cancelled", member_id: "cancelled-member", status: "cancelled", start_date: "2099-01-01", end_date: "2099-01-30", created_at: "2026-11-02" }
    ];
    const mock = mockMembershipReads(memberRows, historyRows);

    const result = await listMembers({ page: 1, limit: 20, gymId }, mock.client);

    assert.deepEqual(result.members.map((entry) => entry.membership_status), [
        "active", "upcoming", "expired", "cancelled", "unassigned"
    ]);
    assert.equal(result.members[0].current_membership.plan_name, "Monthly");
    assert.equal(mock.calls.filter((call) => call.table === "member_memberships").length, 1);
    assert.ok(mock.calls.find((call) => call.table === "members").operations
        .some(([method, field, value]) => method === "is" && field === "archived_at" && value === null));
    assert.ok(mock.calls.find((call) => call.table === "members").operations
        .some(([method, field, value]) => method === "eq" && field === "gym_id" && value === gymId));
    assert.deepEqual(
        mock.calls.find((call) => call.table === "member_memberships").operations
            .find(([method]) => method === "in"),
        ["in", "member_id", memberRows.map((entry) => entry.id)]
    );
});

test("member list balances use every non-cancelled membership fee and every recorded payment", async () => {
    const memberRows = [
        { id: "renewed", full_name: "Renewed", status: "active" },
        { id: "unpaid", full_name: "Unpaid", status: "active" }
    ];
    const historyRows = [
        { id: "first", member_id: "renewed", status: "assigned", price: 1800, total_fees: 1800, start_date: "2026-08-01", end_date: "2026-08-30", created_at: "2026-08-01" },
        { id: "second", member_id: "renewed", status: "assigned", price: 1800, total_fees: 1500, start_date: "2026-09-01", end_date: "2026-09-30", created_at: "2026-09-01" },
        { id: "cancelled", member_id: "renewed", status: "cancelled", price: 4800, total_fees: 4800, start_date: "2026-10-01", end_date: "2026-12-29", created_at: "2026-10-01" },
        { id: "third", member_id: "unpaid", status: "assigned", price: 1800, total_fees: 1800, start_date: "2026-11-01", end_date: "2026-11-30", created_at: "2026-11-01" }
    ];
    const paymentRows = [
        { id: "p1", member_id: "renewed", amount: "1800.00" },
        { id: "p2", member_id: "renewed", amount: "500.50" }
    ];
    const mock = mockMembershipReads(memberRows, historyRows, paymentRows);

    const result = await listMembers({ page: 1, limit: 20, gymId }, mock.client);

    assert.deepEqual(result.members.map((entry) => entry.billing), [
        { billed: 3300, paid: 2300.5, outstanding: 999.5 },
        { billed: 1800, paid: 0, outstanding: 1800 }
    ]);
    const paymentsQuery = mock.calls.find((call) => call.table === "payments");
    assert.ok(paymentsQuery.operations.some(([method, field, value]) => method === "eq" && field === "gym_id" && value === gymId));
    assert.deepEqual(paymentsQuery.operations.find(([method]) => method === "in"), ["in", "member_id", ["renewed", "unpaid"]]);
});

test("billing never reports a negative outstanding balance and falls back to the plan price", () => {
    assert.deepEqual(memberBilling([{ status: "assigned", price: 1000 }], [{ amount: 1200 }]), { billed: 1000, paid: 1200, outstanding: 0 });
    assert.deepEqual(memberBilling([], []), { billed: 0, paid: 0, outstanding: 0 });
});

test("member list reads payments past the 1000-row API page limit", async () => {
    const memberRows = [{ id: "busy", full_name: "Busy", status: "active" }];
    const pages = [Array.from({ length: 1000 }, (_, index) => ({ id: `a${index}`, member_id: "busy", amount: 1 })), [{ id: "last", member_id: "busy", amount: 5 }]];
    const ranges = [];
    const client = {
        from(table) {
            const query = {};
            for (const method of ["select", "order", "eq", "or", "in", "is"]) query[method] = () => query;
            let start = 0;
            query.range = (from, to) => {
                if (table === "payments") ranges.push([from, to]);
                start = from;
                return query;
            };
            query.then = (resolve, reject) => {
                const data = table === "members" ? memberRows : table === "payments" ? pages[start / 1000] || [] : [];
                return Promise.resolve({ data, count: memberRows.length, error: null }).then(resolve, reject);
            };
            return query;
        }
    };
    const result = await listMembers({ page: 1, limit: 20, gymId }, client);
    assert.deepEqual(ranges, [[0, 999], [1000, 1999]]);
    assert.equal(result.members[0].billing.paid, 1005);
});

test("member list can include archived rows when explicitly requested", async () => {
    const mock = mockMembershipReads([{ id: "archived-member", full_name: "Archived", status: "active" }], []);
    await listMembers({ page: 1, limit: 25, includeArchived: true, gymId }, mock.client);
    assert.equal(mock.calls.find((call) => call.table === "members").operations
        .some(([method, field]) => method === "is" && field === "archived_at"), false);
});

test("member deletion archives the row instead of deleting it", async () => {
    const mock = mockSupabase({ id: "member-id" });
    await deleteMember("member-id", gymId, mock.client);
    const archive = mock.calls.find((call) => call.operation === "update");
    assert.ok(archive);
    assert.ok(archive.record.archived_at);
    assert.equal(archive.record.archived_at, archive.record.updated_at);
    assert.equal(mock.calls.some((call) => call.operation === "is" && call.field === "archived_at"), true);
});

test("a gym-scoped member lookup, update, and archive cannot target another gym's row", async () => {
    for (const action of [
        (client) => getMember("member-owned-by-gym-b", gymId, client),
        (client) => updateMember("member-owned-by-gym-b", { full_name: "Intruder" }, gymId, client),
        (client) => deleteMember("member-owned-by-gym-b", gymId, client)
    ]) {
        const mock = mockSupabase(null);
        await assert.rejects(action(mock.client), (error) => error.status === 404);
        assert.ok(mock.calls.some((call) => call.operation === "eq"
            && call.field === "gym_id" && call.value === gymId));
    }
});

test("single-member GET attaches the member's current membership", async () => {
    const memberRow = { id: "active-member", full_name: "Active", status: "active" };
    const membershipRow = {
        id: "membership-active",
        member_id: memberRow.id,
        status: "assigned",
        start_date: "2026-11-06",
        end_date: "2026-12-05",
        created_at: "2026-11-01"
    };
    const mock = mockMembershipReads([memberRow], [membershipRow]);
    const result = await getMember(memberRow.id, gymId, mock.client);

    assert.equal(result.current_membership.id, membershipRow.id);
    assert.equal(result.membership_status, "active");
});
