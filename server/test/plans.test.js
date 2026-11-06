import test from "node:test";
import assert from "node:assert/strict";
import {
    validatePlanId,
    validatePlanListQuery,
    validatePlanPayload
} from "../middleware/validatePlan.js";
import * as plansService from "../services/plansService.js";

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

function mockSupabase(results) {
    const calls = [];
    let resultIndex = 0;
    const client = {
        from(table) {
            const call = { table, operations: [] };
            calls.push(call);
            const builder = {};
            for (const method of ["select", "order", "range", "is", "eq", "ilike", "insert", "update", "delete"]) {
                builder[method] = (...args) => {
                    call.operations.push([method, ...args]);
                    return builder;
                };
            }
            builder.maybeSingle = () => Promise.resolve(results[resultIndex++]);
            builder.single = () => Promise.resolve(results[resultIndex++]);
            builder.then = (resolve, reject) => Promise.resolve(results[resultIndex++]).then(resolve, reject);
            return builder;
        }
    };
    return { client, calls };
}

const validPlan = {
    name: "Quarterly",
    description: "Three month membership",
    duration_days: 90,
    price: 2499,
    is_active: true
};
const planRecord = {
    id: "00000000-0000-4000-8000-000000000001",
    gym_id: null,
    ...validPlan,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
};

test("valid plan creation payload is normalized", () => {
    const result = invoke(validatePlanPayload("create"), { body: { ...validPlan, name: "  Quarterly  " } });
    assert.equal(result.nextCalled, true);
    assert.equal(result.request.validatedPlan.name, "Quarterly");
});

test("plan validation rejects missing names, invalid durations and prices", () => {
    const cases = [
        { name: "   ", duration_days: 30, price: 0 },
        { name: "Monthly", duration_days: 0, price: 999 },
        { name: "Monthly", duration_days: -1, price: 999 },
        { name: "Monthly", duration_days: 1.5, price: 999 },
        { name: "Monthly", duration_days: 30, price: -1 },
        { name: "Monthly", duration_days: 30, price: "999" },
        { name: "Monthly", price: 999 }
    ];
    for (const body of cases) {
        const result = invoke(validatePlanPayload("create"), { body });
        assert.equal(result.nextCalled, false, JSON.stringify(body));
        assert.equal(result.response.statusCode, 400);
        assert.equal(result.response.body.status, "error");
    }
});

test("plan update accepts permitted partial fields and rejects invalid status", () => {
    const valid = invoke(validatePlanPayload("update"), { body: { is_active: false } });
    const invalid = invoke(validatePlanPayload("update"), { body: { is_active: "false" } });
    assert.equal(valid.nextCalled, true);
    assert.deepEqual(valid.request.validatedPlan, { is_active: false });
    assert.equal(invalid.response.statusCode, 400);
});

test("plan IDs must be UUIDs", () => {
    const invalid = invoke(validatePlanId, { params: { id: "not-a-uuid" } });
    const valid = invoke(validatePlanId, { params: { id: planRecord.id } });
    assert.equal(invalid.response.statusCode, 400);
    assert.equal(valid.nextCalled, true);
});

test("plan listing applies pagination, status, and name search", async () => {
    const mock = mockSupabase([{ data: [planRecord], count: 1, error: null }]);
    const result = await plansService.listPlans(
        { page: 2, limit: 10, status: "inactive", search: "quarter" },
        mock.client
    );
    assert.deepEqual(result, { plans: [planRecord], total: 1 });
    assert.ok(mock.calls[0].operations.some(([name, field, value]) => name === "is" && field === "gym_id" && value === null));
    assert.ok(mock.calls[0].operations.some(([name, field, value]) => name === "eq" && field === "is_active" && value === false));
    assert.ok(mock.calls[0].operations.some(([name, field, value]) => name === "ilike" && field === "name" && value === "%quarter%"));
    assert.ok(mock.calls[0].operations.some(([name, from, to]) => name === "range" && from === 10 && to === 19));
});

test("plan creation succeeds and duplicate names return HTTP conflict semantics", async () => {
    const success = mockSupabase([{ data: planRecord, error: null }]);
    assert.deepEqual(await plansService.createPlan(validPlan, success.client), planRecord);
    assert.ok(success.calls[0].operations.some(([name, value]) => name === "insert" && value.gym_id === null));

    const duplicate = mockSupabase([{ error: { code: "23505" } }]);
    await assert.rejects(plansService.createPlan(validPlan, duplicate.client), (error) => error.status === 409);
});

test("getting a missing plan returns not found", async () => {
    const mock = mockSupabase([{ data: null, error: null }]);
    await assert.rejects(plansService.getPlan(planRecord.id, mock.client), (error) => error.status === 404);
});

test("plan update returns the updated plan", async () => {
    const updated = { ...planRecord, is_active: false };
    const mock = mockSupabase([{ data: updated, error: null }]);
    assert.deepEqual(await plansService.updatePlan(planRecord.id, { is_active: false }, mock.client), updated);
});

test("plan deletion succeeds, reports missing IDs, and blocks related records", async () => {
    const deleted = mockSupabase([{ data: { id: planRecord.id }, error: null }]);
    assert.equal(await plansService.deletePlan(planRecord.id, deleted.client), undefined);

    const missing = mockSupabase([{ data: null, error: null }]);
    await assert.rejects(plansService.deletePlan(planRecord.id, missing.client), (error) => error.status === 404);

    const related = mockSupabase([{ error: { code: "23503" } }]);
    await assert.rejects(plansService.deletePlan(planRecord.id, related.client), (error) => error.status === 409);
});
