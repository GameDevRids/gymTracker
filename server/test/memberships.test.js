import test from "node:test";
import assert from "node:assert/strict";
import {
    validateAssignmentPayload,
    validateExpiringMembershipQuery,
    validateMembershipId,
    validateMembershipListQuery
} from "../middleware/validateMembership.js";
import { validateMemberId } from "../middleware/validateMember.js";
import {
    assignMemberPlan,
    effectiveMembershipStatus,
    getMembership,
    listMemberMemberships,
    listMemberships,
    listExpiringMemberships,
    selectCurrentMembership
} from "../services/membershipsService.js";

const memberId = "00000000-0000-4000-8000-000000000001";
const exampleMemberId = "5bfff1a2-3b1c-4a66-a88b-d9ea7e97238a";
const planId = "00000000-0000-4000-8000-000000000002";
const membershipId = "00000000-0000-4000-8000-000000000003";
const gymId = "00000000-0000-4000-8000-000000000099";
const validPayload = { plan_id: planId, start_date: "2026-11-06" };
const assignment = {
    id: membershipId,
    gym_id: gymId,
    member_id: memberId,
    plan_id: planId,
    plan_name: "Monthly",
    duration_days: 30,
    price: 999,
    total_fees: 899,
    start_date: "2026-11-06",
    end_date: "2026-12-05",
    status: "assigned",
    created_at: "2026-11-06T09:00:00.000Z",
    updated_at: "2026-11-06T09:00:00.000Z"
};

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

function mockSupabase(results, rpcResult) {
    const calls = [];
    let resultIndex = 0;
    return {
        calls,
        client: {
            from(table) {
                const call = { table, operations: [] };
                calls.push(call);
                const builder = {};
                for (const method of ["select", "eq", "is", "order", "range"]) {
                    builder[method] = (...args) => {
                        call.operations.push([method, ...args]);
                        return builder;
                    };
                }
                builder.maybeSingle = () => Promise.resolve(results[resultIndex++]);
                builder.then = (resolve, reject) => Promise.resolve(results[resultIndex++]).then(resolve, reject);
                return builder;
            },
            rpc(name, params) {
                calls.push({ rpc: name, params });
                return Promise.resolve(rpcResult);
            }
        }
    };
}

test("assignment request validates member and plan UUIDs and the date", () => {
    const accepted = invoke(validateAssignmentPayload, { body: validPayload });
    assert.equal(accepted.nextCalled, true);
    assert.deepEqual(accepted.request.validatedAssignment, validPayload);
    const withTotalFees = invoke(validateAssignmentPayload, { body: { ...validPayload, total_fees: 1200 } });
    assert.equal(withTotalFees.nextCalled, true);
    assert.equal(withTotalFees.request.validatedAssignment.total_fees, 1200);

    for (const body of [
        { ...validPayload, plan_id: "bad-id" },
        { ...validPayload, start_date: "2026-02-30" },
        { ...validPayload, start_date: "06-11-2026" },
        { ...validPayload, price: 1 },
        { ...validPayload, total_fees: -1 }
    ]) {
        const rejected = invoke(validateAssignmentPayload, { body });
        assert.equal(rejected.nextCalled, false);
        assert.equal(rejected.response.statusCode, 400);
    }

    assert.equal(invoke(validateMembershipId, { params: { id: membershipId } }).nextCalled, true);
    assert.equal(invoke(validateMembershipId, { params: { id: "invalid" } }).response.statusCode, 400);
});

test("membership list pagination defaults to 25", () => {
    const result = invoke(validateMembershipListQuery, { query: {} });
    assert.equal(result.nextCalled, true);
    assert.deepEqual(result.request.membershipListQuery, { page: 1, limit: 25 });
});

test("expiring membership query accepts only supported windows and defaults to seven days", () => {
    const defaults = invoke(validateExpiringMembershipQuery, { query: {} });
    assert.equal(defaults.nextCalled, true);
    assert.deepEqual(defaults.request.expiringMembershipQuery, { days: 7 });
    for (const days of ["3", "7", "15", "30"]) {
        assert.deepEqual(invoke(validateExpiringMembershipQuery, { query: { days } }).request.expiringMembershipQuery, { days: Number(days) });
    }
    assert.equal(invoke(validateExpiringMembershipQuery, { query: { days: "8" } }).response.statusCode, 400);
});

test("assignment member route validates the memberId parameter as a UUID", () => {
    assert.equal(invoke(validateMemberId, { params: { memberId: exampleMemberId } }).nextCalled, true);
    assert.equal(invoke(validateMemberId, { params: { memberId } }).nextCalled, true);

    for (const params of [
        { memberId: "5bfff1a2-3b1c-4a66-a88b-d9ea7e97238" },
        { memberId: "not-a-uuid" },
        {}
    ]) {
        const rejected = invoke(validateMemberId, { params });
        assert.equal(rejected.nextCalled, false);
        assert.equal(rejected.response.statusCode, 400);
        assert.equal(rejected.response.body.message, "Member ID must be a valid UUID.");
    }

    assert.equal(invoke(validateMemberId, { params: { id: exampleMemberId } }).nextCalled, true);
});

test("assignment uses the database-created plan snapshot and returns effective status", async () => {
    const mock = mockSupabase([], { data: [assignment], error: null });
    const saved = await assignMemberPlan(memberId, validPayload, gymId, mock.client);
    assert.equal(mock.calls.length, 1);
    assert.equal(saved.id, membershipId);
    assert.equal(saved.plan_name, "Monthly");
    assert.equal(saved.duration_days, 30);
    assert.equal(saved.price, 999);
    assert.equal(saved.effective_status, effectiveMembershipStatus(assignment));
    assert.deepEqual(mock.calls[0], {
        rpc: "gympulse_assign_member_plan",
        params: { p_member_id: memberId, p_plan_id: planId, p_start_date: validPayload.start_date, p_gym_id: gymId, p_total_fees: null }
    });
});

test("assignment maps missing member or plan and inactive plan errors", async () => {
    for (const error of [
        { code: "P0002", message: "Member not found." },
        { code: "P0002", message: "Plan not found." }
    ]) {
        const mock = mockSupabase([], { data: null, error });
        await assert.rejects(assignMemberPlan(memberId, validPayload, gymId, mock.client), (failure) => failure.status === 404);
    }
    const inactive = mockSupabase([], { data: null, error: { code: "P0001", message: "Only active plans can be assigned." } });
    await assert.rejects(assignMemberPlan(memberId, validPayload, gymId, inactive.client), (failure) => failure.status === 409);
});

test("assignment returns not found when the supplied member UUID does not exist", async () => {
    const mock = mockSupabase([], {
        data: null,
        error: { code: "P0002", message: "Member not found." }
    });
    await assert.rejects(
        assignMemberPlan(exampleMemberId, validPayload, gymId, mock.client),
        (failure) => failure.status === 404 && failure.message === "Member not found."
    );
    assert.deepEqual(mock.calls[0], {
        rpc: "gympulse_assign_member_plan",
        params: {
            p_member_id: exampleMemberId,
            p_plan_id: planId,
            p_start_date: validPayload.start_date,
            p_gym_id: gymId,
            p_total_fees: null
        }
    });
});

test("assignment rejects unavailable RPC with a migration hint", async () => {
    const mock = mockSupabase([], { data: null, error: { code: "PGRST202" } });
    await assert.rejects(
        assignMemberPlan(memberId, validPayload, gymId, mock.client),
        (failure) => failure.status === 503 && failure.message.includes("004_create_member_memberships.sql")
    );
});

test("membership listing reports when the history migration has not been applied", async () => {
    const mock = mockSupabase([{ data: null, error: { code: "PGRST205" } }]);
    await assert.rejects(
        listMemberships({ page: 1, limit: 20, gymId }, mock.client),
        (failure) => failure.status === 503 && failure.message.includes("004_create_member_memberships.sql")
    );
});

test("membership listing reports insufficient Supabase service-role permissions", async () => {
    const mock = mockSupabase([{ data: null, error: {
        code: "42501",
        message: "permission denied for table member_memberships",
        details: null,
        hint: "Grant the required privileges to the current role."
    } }]);
    await assert.rejects(
        listMemberships({ page: 1, limit: 20, gymId }, mock.client),
        (failure) => failure.status === 503
            && failure.message.includes("backend service credentials")
    );
});

test("overlapping membership returns a conflict while non-overlap sequential assignments can be created", async () => {
    const overlap = mockSupabase([], { data: null, error: { code: "23P01" } });
    await assert.rejects(
        assignMemberPlan(memberId, validPayload, gymId, overlap.client),
        (failure) => failure.status === 409 && failure.message.includes("already has a membership")
    );

    const next = {
        ...assignment,
        id: "00000000-0000-4000-8000-000000000004",
        plan_name: "Quarterly",
        duration_days: 90,
        price: 2499,
        start_date: "2026-12-06",
        end_date: "2027-03-05"
    };
    const sequential = mockSupabase([], { data: [next], error: null });
    const saved = await assignMemberPlan(memberId, { plan_id: planId, start_date: "2026-12-06" }, gymId, sequential.client);
    assert.equal(saved.start_date, "2026-12-06");
    assert.equal(saved.plan_name, "Quarterly");
    assert.equal(saved.price, 2499);
    assert.equal(assignment.price, 999);
});

test("effective status reflects upcoming, active, expired, and cancelled memberships", () => {
    assert.equal(effectiveMembershipStatus(assignment, "2026-11-05"), "upcoming");
    assert.equal(effectiveMembershipStatus(assignment, "2026-11-06"), "active");
    assert.equal(effectiveMembershipStatus(assignment, "2026-12-06"), "expired");
    assert.equal(effectiveMembershipStatus({ ...assignment, status: "cancelled" }, "2026-11-06"), "cancelled");
});

test("current membership selection prefers active, then nearest upcoming, then latest history", () => {
    const active = { ...assignment, id: "active", start_date: "2026-11-06", end_date: "2026-12-05", created_at: "2026-10-01" };
    const upcoming = { ...assignment, id: "upcoming", start_date: "2026-12-10", end_date: "2027-01-08", created_at: "2026-11-01" };
    const nearerUpcoming = { ...upcoming, id: "nearer", start_date: "2026-11-10", end_date: "2026-12-09", created_at: "2026-10-01" };
    const expired = { ...assignment, id: "expired", start_date: "2026-10-01", end_date: "2026-10-30", created_at: "2026-10-01" };
    const cancelled = { ...assignment, id: "cancelled", status: "cancelled", created_at: "2026-11-02" };

    assert.equal(selectCurrentMembership([upcoming, active, nearerUpcoming], "2026-11-06").id, "active");
    assert.equal(selectCurrentMembership([upcoming, nearerUpcoming], "2026-11-06").id, "nearer");
    assert.equal(selectCurrentMembership([expired, cancelled], "2026-11-06").id, "cancelled");
    assert.equal(selectCurrentMembership([expired], "2026-11-06").effective_status, "expired");
    assert.equal(selectCurrentMembership([], "2026-11-06"), null);
});

test("expiring list returns expired and in-window current memberships, sorted by end date", async () => {
    const rows = [
        { ...assignment, id: "expiring", member_id: memberId, end_date: "2026-11-09", members: { id: memberId, full_name: "Riya Shah", phone: "9876543210" } },
        { ...assignment, id: "expired", member_id: exampleMemberId, end_date: "2026-11-05", members: { id: exampleMemberId, full_name: "Aman Rao", phone: "9876543211" } },
        { ...assignment, id: "later", member_id: "00000000-0000-4000-8000-000000000004", end_date: "2026-11-15", members: { id: "00000000-0000-4000-8000-000000000004", full_name: "Zoya Khan", phone: "9876543212" } }
    ];
    const mock = mockSupabase([{ data: rows, error: null }]);
    const memberships = await listExpiringMemberships({ days: 7, gymId }, mock.client, "2026-11-06");
    assert.deepEqual(memberships.map((item) => item.id), ["expired", "expiring"]);
    assert.deepEqual(memberships.map((item) => item.days_left), [-1, 3]);
    assert.equal(memberships[1].member.full_name, "Riya Shah");
    assert.equal(memberships[1].effective_status, "active");
    assert.ok(mock.calls.some((call) => call.table === "member_memberships"
        && call.operations.some(([name, select]) => name === "select"
            && select.includes("members!member_memberships_member_id_fkey!inner("))));
});

test("membership history is returned newest-first with effective statuses", async () => {
    const mock = mockSupabase([
        { data: { id: memberId }, error: null },
        { data: [assignment], error: null }
    ]);
    const memberships = await listMemberMemberships(memberId, gymId, mock.client);
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].plan_name, "Monthly");
    assert.ok(mock.calls.some((call) => call.table === "member_memberships"
        && call.operations.some(([name, field, options]) => name === "order" && field === "start_date" && options.ascending === false)));
    assert.ok(mock.calls.some((call) => call.table === "members"
        && call.operations.some(([name, field, value]) => name === "is" && field === "archived_at" && value === null)));
});

test("members without membership history receive an empty history", async () => {
    const mock = mockSupabase([
        { data: { id: memberId }, error: null },
        { data: [], error: null }
    ]);
    assert.deepEqual(await listMemberMemberships(memberId, gymId, mock.client), []);
});

test("missing membership returns not found", async () => {
    const mock = mockSupabase([{ data: null, error: null }]);
    await assert.rejects(getMembership(membershipId, gymId, mock.client), (failure) => failure.status === 404);
});
