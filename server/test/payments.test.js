import test from "node:test";
import assert from "node:assert/strict";
import { validatePaymentPayload } from "../middleware/validatePayment.js";
import { createPayment, listMemberPayments } from "../services/paymentsService.js";

const memberId = "00000000-0000-4000-8000-000000000001";
const membershipId = "00000000-0000-4000-8000-000000000002";
const gymId = "00000000-0000-4000-8000-000000000099";
const payment = {
    member_id: memberId,
    membership_id: membershipId,
    idempotency_key: "00000000-0000-4000-8000-0000000000d1",
    amount: 1250,
    method: "upi",
    paid_on: "2026-11-06",
    note: "Monthly plan"
};

function invoke(middleware, body) {
    const request = { body };
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; }
    };
    let nextCalled = false;
    middleware(request, response, () => { nextCalled = true; });
    return { request, response, nextCalled };
}

function mockSupabase(results) {
    const calls = [];
    let resultIndex = 0;
    return {
        calls,
        client: {
            from(table) {
                const call = { table, operations: [] };
                calls.push(call);
                const builder = {};
                for (const method of ["select", "eq", "is", "order", "insert"]) {
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
        }
    };
}

test("payment validator accepts supported payload and rejects invalid data", () => {
    const accepted = invoke(validatePaymentPayload, payment);
    assert.equal(accepted.nextCalled, true);
    assert.equal(accepted.request.validatedPayment.amount, 1250);
    for (const invalid of [
        { ...payment, method: "bank transfer" },
        { ...payment, amount: 0 },
        { ...payment, paid_on: "2026-02-30" },
        { ...payment, unexpected: true },
        { ...payment, membership_id: undefined },
        { ...payment, idempotency_key: undefined },
        { ...payment, gym_id: gymId }
    ]) {
        assert.equal(invoke(validatePaymentPayload, invalid).response.statusCode, 400);
    }
});

test("payment creation goes through one database function with the gym from the sign-in and the request key", async () => {
    const saved = { id: "p1", ...payment, gym_id: gymId };
    const sent = [];
    const client = { rpc: (name, args) => { sent.push([name, args]); return Promise.resolve({ data: { replayed: false, balance_due: 250, payment: saved }, error: null }); } };
    assert.deepEqual(await createPayment(payment, { gymId, userId: "u1" }, client), { payment: saved, balance_due: 250, replayed: false });
    assert.equal(sent[0][0], "gympulse_record_payment");
    assert.deepEqual(sent[0][1], {
        p_gym_id: gymId, p_member_id: memberId, p_membership_id: membershipId, p_amount: 1250, p_method: "upi", p_paid_on: "2026-11-06",
        p_note: "Monthly plan", p_upi_reference: null, p_idempotency_key: payment.idempotency_key, p_recorded_by: "u1"
    });
});

test("member payment history is newest first and rejects unknown member", async () => {
    const records = [{ id: membershipId, member_id: memberId, amount: 1250, paid_on: "2026-11-06" }];
    const mock = mockSupabase([
        { data: { id: memberId }, error: null },
        { data: records, error: null }
    ]);
    assert.deepEqual(await listMemberPayments(memberId, gymId, mock.client), records);
    assert.ok(mock.calls[1].operations.some(([name, field, options]) => name === "order" && field === "paid_on" && options.ascending === false));

    const missing = mockSupabase([{ data: null, error: null }]);
    await assert.rejects(listMemberPayments(memberId, gymId, missing.client), (error) => error.status === 404);
});
