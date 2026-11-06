import test from "node:test";
import assert from "node:assert/strict";
import {
    validateAssignmentPayload,
    validateMembershipId
} from "../middleware/validateMembership.js";
import {
    assignMemberPlan,
    effectiveMembershipStatus,
    getMembership,
    listMemberMemberships,
    listMemberships
} from "../services/membershipsService.js";

const memberId = "00000000-0000-4000-8000-000000000001";
const planId = "00000000-0000-4000-8000-000000000002";
const membershipId = "00000000-0000-4000-8000-000000000003";
const validPayload = { plan_id: planId, start_date: "2026-11-06" };
const assignment = {
    id: membershipId,
    gym_id: null,
    member_id: memberId,
    plan_id: planId,
    plan_name: "Monthly",
    duration_days: 30,
    price: 999,
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

    for (const body of [
        { ...validPayload, plan_id: "bad-id" },
        { ...validPayload, start_date: "2026-02-30" },
        { ...validPayload, start_date: "06-11-2026" },
        { ...validPayload, price: 1 }
    ]) {
        const rejected = invoke(validateAssignmentPayload, { body });
        assert.equal(rejected.nextCalled, false);
        assert.equal(rejected.response.statusCode, 400);
    }

    assert.equal(invoke(validateMembershipId, { params: { id: memberId } }).nextCalled, true);
    assert.equal(invoke(validateMembershipId, { params: { id: "invalid" } }).response.statusCode, 400);
});

test("assignment uses the database-created plan snapshot and returns effective status", async () => {
    const mock = mockSupabase([], { data: [assignment], error: null });
    const saved = await assignMemberPlan(memberId, validPayload, mock.client);
    assert.equal(mock.calls.length, 1);
    assert.equal(saved.id, membershipId);
    assert.equal(saved.plan_name, "Monthly");
    assert.equal(saved.duration_days, 30);
    assert.equal(saved.price, 999);
    assert.equal(saved.effective_status, effectiveMembershipStatus(assignment));
    assert.deepEqual(mock.calls[0], {
        rpc: "gympulse_assign_member_plan",
        params: { p_member_id: memberId, p_plan_id: planId, p_start_date: validPayload.start_date }
    });
});

test("assignment maps missing member or plan and inactive plan errors", async () => {
    for (const error of [
        { code: "P0002", message: "Member not found." },
        { code: "P0002", message: "Plan not found." }
    ]) {
        const mock = mockSupabase([], { data: null, error });
        await assert.rejects(assignMemberPlan(memberId, validPayload, mock.client), (failure) => failure.status === 404);
    }
    const inactive = mockSupabase([], { data: null, error: { code: "P0001", message: "Only active plans can be assigned." } });
    await assert.rejects(assignMemberPlan(memberId, validPayload, inactive.client), (failure) => failure.status === 409);
});

test("assignment rejects unavailable RPC with a migration hint", async () => {
    const mock = mockSupabase([], { data: null, error: { code: "PGRST202" } });
    await assert.rejects(
        assignMemberPlan(memberId, validPayload, mock.client),
        (failure) => failure.status === 503 && failure.message.includes("004_create_member_memberships.sql")
    );
});

test("membership listing reports when the history migration has not been applied", async () => {
    const mock = mockSupabase([{ data: null, error: { code: "PGRST205" } }]);
    await assert.rejects(
        listMemberships({ page: 1, limit: 20 }, mock.client),
        (failure) => failure.status === 503 && failure.message.includes("004_create_member_memberships.sql")
    );
});

test("overlapping membership returns a conflict while non-overlap sequential assignments can be created", async () => {
    const overlap = mockSupabase([], { data: null, error: { code: "23P01" } });
    await assert.rejects(
        assignMemberPlan(memberId, validPayload, overlap.client),
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
    const saved = await assignMemberPlan(memberId, { plan_id: planId, start_date: "2026-12-06" }, sequential.client);
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

test("membership history is returned newest-first with effective statuses", async () => {
    const mock = mockSupabase([
        { data: { id: memberId }, error: null },
        { data: [assignment], error: null }
    ]);
    const memberships = await listMemberMemberships(memberId, mock.client);
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].plan_name, "Monthly");
    assert.ok(mock.calls.some((call) => call.table === "member_memberships"
        && call.operations.some(([name, field, options]) => name === "order" && field === "start_date" && options.ascending === false)));
});

test("missing membership returns not found", async () => {
    const mock = mockSupabase([{ data: null, error: null }]);
    await assert.rejects(getMembership(membershipId, mock.client), (failure) => failure.status === 404);
});
