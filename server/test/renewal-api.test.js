// One-tap renewal on the server: the request is checked, the gym and the staff member come from the
// sign-in, repeats are answered 200 instead of 201, and every database failure becomes a clear
// answer. The database function itself is tested in renewal-migration.test.js.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { validateMemberId } from "../middleware/validateMember.js";
import { validateRenewPayload } from "../middleware/validateRenewal.js";
import { createRenewHandler } from "../controllers/renewalsController.js";
import { membersErrorHandler } from "../controllers/membersController.js";
import { RenewalError, renewMember, renewalsForMemberships } from "../services/renewalsService.js";

const gymId = "00000000-0000-4000-8000-0000000000a1";
const userId = "00000000-0000-4000-8000-0000000000e1";
const memberId = "00000000-0000-4000-8000-000000000011";
const planId = "00000000-0000-4000-8000-000000000021";
const key = "00000000-0000-4000-8000-0000000000f1";
const body = { idempotency_key: key, plan_id: planId, expected_start: "2026-11-20", total_fees: 1350, amount_paid: 1000, method: "upi", upi_reference: "123456789012" };

const savedResult = (extra = {}) => ({
    replayed: false,
    renewal: { id: "r1", plan_price: 1500, fee: 1350, amount_paid: 1000, start_choice: "after_current" },
    membership: { id: "m2", member_id: memberId, plan_name: "Monthly", start_date: "2026-11-20", end_date: "2026-12-19", status: "assigned" },
    payment: { id: "p1", receipt_number: "R-000007", amount: 1000, method: "upi" },
    balance: { billed: 1350, paid: 1000, outstanding: 350 },
    ...extra
});

// ---------- The route, with the real checks and a fake service ----------

const calls = [];
let behaviour = () => savedResult();
let server;
let baseUrl;

before(async () => {
    const app = express();
    app.use(express.json());
    app.post("/api/members/:id/renew", (request, _response, next) => {
        request.gymId = gymId;
        request.authUser = { id: userId };
        next();
    }, validateMemberId, validateRenewPayload, createRenewHandler(async (...args) => {
        calls.push(args);
        return behaviour();
    }), membersErrorHandler);
    app.use(membersErrorHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const post = (payload, id = memberId) => fetch(`${baseUrl}/api/members/${id}/renew`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

test("a renewal is saved with the signed-in gym and staff member, and answers 201", async () => {
    calls.length = 0;
    behaviour = () => savedResult();
    const response = await post(body);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).data.membership.plan_name, "Monthly");
    assert.deepEqual(calls[0], [memberId, body, { gymId, userId }]);
});

test("the same request again answers 200 and says it was a repeat", async () => {
    behaviour = () => savedResult({ replayed: true });
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.replayed, true);
});

test("a gym or a start date sent by the browser is refused: only the checked fields are accepted", async () => {
    calls.length = 0;
    for (const extra of [{ gym_id: "00000000-0000-4000-8000-0000000000b1" }, { start_date: "2020-01-01" }, { member_id: memberId }, { recorded_by: userId }]) {
        const response = await post({ ...body, ...extra });
        assert.equal(response.status, 400, JSON.stringify(extra));
        assert.equal((await response.json()).code, "invalid");
    }
    assert.equal(calls.length, 0, "the service was never reached");
});

test("bad fields are refused before anything is saved", async () => {
    calls.length = 0;
    const bad = [
        { ...body, idempotency_key: "not-a-key" },
        { ...body, idempotency_key: undefined },
        { ...body, plan_id: "nope" },
        { ...body, total_fees: -5 },
        { ...body, amount_paid: "1000" },
        { ...body, method: "cheque" },
        { ...body, upi_reference: "12345" },
        { ...body, expected_start: "2026-02-30" }
    ];
    for (const payload of bad) assert.equal((await post(payload)).status, 400, JSON.stringify(payload));
    assert.equal((await post(body, "not-a-member-id")).status, 400);
    assert.equal(calls.length, 0);
});

test("only the key and the plan are required; fee, payment and method are optional", async () => {
    calls.length = 0;
    behaviour = () => savedResult();
    assert.equal((await post({ idempotency_key: key, plan_id: planId })).status, 201);
    assert.equal((await post({ ...body, upi_reference: "" })).status, 201, "an empty UTR is the same as none");
    assert.equal(calls[1][1].upi_reference, null);
});

test("amounts are rounded to paise", async () => {
    calls.length = 0;
    behaviour = () => savedResult();
    await post({ ...body, total_fees: 1349.999, amount_paid: 1000.004 });
    assert.equal(calls[0][1].total_fees, 1350);
    assert.equal(calls[0][1].amount_paid, 1000);
});

test("a plan that would overlap comes back as 409 with a code the app words its message from", async () => {
    behaviour = async () => { throw new RenewalError(409, "This member already has a plan starting on 20 Nov 2026. Renewing now would overlap it.", "future_plan"); };
    const response = await post(body);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { status: "error", message: "This member already has a plan starting on 20 Nov 2026. Renewing now would overlap it.", code: "future_plan" });
});

test("an unexpected failure is a plain 500 that leaks nothing", async () => {
    behaviour = async () => { throw new Error("connection string postgres://secret"); };
    const response = await post(body);
    assert.equal(response.status, 500);
    assert.doesNotMatch(JSON.stringify(await response.json()), /secret/);
});

// ---------- The service, with a fake database function ----------

function fakeClient(answer) {
    const rpcCalls = [];
    return { rpcCalls, rpc: async (name, args) => { rpcCalls.push([name, args]); return typeof answer === "function" ? answer() : answer; } };
}

test("the database function gets the gym and staff member from the caller, and the request as sent", async () => {
    const client = fakeClient({ data: savedResult(), error: null });
    const result = await renewMember(memberId, { ...body, backdate: true }, { gymId, userId }, client);
    assert.equal(client.rpcCalls[0][0], "gympulse_renew_member");
    assert.deepEqual(client.rpcCalls[0][1], {
        p_gym_id: gymId, p_member_id: memberId, p_idempotency_key: key, p_plan_id: planId, p_backdate: true,
        p_expected_start: "2026-11-20", p_total_fees: 1350, p_amount_paid: 1000, p_method: "upi", p_upi_reference: "123456789012", p_recorded_by: userId
    });
    assert.equal(typeof result.membership.effective_status, "string", "the plan arrives with its status");
    assert.equal(result.payment.receipt_number, "R-000007");
});

test("defaults: no fee means the plan's price, no payment means zero, cash, no UTR", async () => {
    const client = fakeClient({ data: savedResult(), error: null });
    await renewMember(memberId, { idempotency_key: key, plan_id: planId }, { gymId }, client);
    const args = client.rpcCalls[0][1];
    assert.deepEqual([args.p_total_fees, args.p_amount_paid, args.p_method, args.p_upi_reference, args.p_backdate, args.p_expected_start, args.p_recorded_by], [null, 0, "cash", null, false, null, null]);
});

test("no gym, or no database, is refused before any call", async () => {
    const client = fakeClient({ data: savedResult(), error: null });
    await assert.rejects(renewMember(memberId, body, { gymId: "" }, client), { status: 403 });
    await assert.rejects(renewMember(memberId, body, { gymId }, null), { status: 503 });
    assert.equal(client.rpcCalls.length, 0);
});

test("every database error becomes a clear answer", async () => {
    const cases = [
        [{ code: "PGRST202", message: "Could not find the function" }, 503, "unavailable", /019_add_one_tap_renewal/],
        [{ code: "42883", message: "function does not exist" }, 503, "unavailable", /019_add_one_tap_renewal/],
        [{ code: "P0002", message: "Member not found." }, 404, "not_found", /Member not found/],
        [{ code: "P0001", message: "This member already has a plan starting on 20 Nov 2026.", details: "future_plan" }, 409, "future_plan", /already has a plan/],
        [{ code: "P0001", message: "The plan dates changed since this screen opened.", details: "dates_changed" }, 409, "dates_changed", /dates changed/],
        [{ code: "P0001", message: "Only active plans can be used for a renewal.", details: "plan_inactive" }, 409, "plan_inactive", /active plans/],
        [{ code: "23P01", message: "overlap" }, 409, "overlap", /membership during those dates/],
        [{ code: "22023", message: "This request key belongs to another member." }, 409, "key_reused", /already used for another member/],
        [{ code: "23505", message: 'duplicate key value violates unique constraint "payments_gym_upi_reference_key"', details: "Key (gym_id, upi_reference)=(x, 1) already exists." }, 409, "utr_taken", /UTR\) is already recorded/],
        [{ code: "23505", message: "duplicate key", details: "" }, 409, "busy", /try again/i],
        [{ code: "23514", message: 'violates check constraint "payments_upi_reference_format"' }, 400, "utr_invalid", /12 digits/],
        [{ code: "23514", message: "The amount paid must be between zero and the fee." }, 400, "amount", /amount paid must be between/],
        [{ code: "XX000", message: "something internal about relation payments" }, 500, "", /could not complete/]
    ];
    for (const [error, status, reason, message] of cases) {
        const failure = await renewMember(memberId, body, { gymId }, fakeClient({ data: null, error })).then(() => null, (thrown) => thrown);
        assert.equal(failure.status, status, error.code + " " + error.message);
        assert.equal(failure.reason, reason, error.message);
        assert.match(failure.message, message);
        assert.doesNotMatch(failure.message, /relation|constraint|payments_/i, "no database internals reach the app");
    }
});

test("an answer without a membership is an error, not a success", async () => {
    await assert.rejects(renewMember(memberId, body, { gymId }, fakeClient({ data: {}, error: null })), { status: 500 });
});

// ---------- Renewal history for the profile ----------

test("renewal details are read for this gym only, and a missing table just means no history", async () => {
    const seen = [];
    const client = {
        from(table) {
            const builder = { select() { return builder; }, eq(field, value) { seen.push([table, field, value]); return builder; }, in(field, values) { seen.push([table, field, values]); return Promise.resolve({ data: [{ membership_id: "m2", plan_price: "1500.00", fee: "1350.00", amount_paid: "1000.00", start_choice: "after_current", created_at: "2026-11-16T05:00:00Z" }], error: null }); } };
            return builder;
        }
    };
    const map = await renewalsForMemberships(["m1", "m2"], gymId, client);
    assert.deepEqual(map.get("m2"), { plan_price: 1500, fee: 1350, amount_paid: 1000, start_choice: "after_current", created_at: "2026-11-16T05:00:00Z" });
    assert.equal(map.has("m1"), false);
    assert.deepEqual(seen[0], ["membership_renewals", "gym_id", gymId]);

    const missingTable = { from: () => { const b = { select: () => b, eq: () => b, in: () => Promise.resolve({ data: null, error: { code: "PGRST205" } }) }; return b; } };
    assert.equal((await renewalsForMemberships(["m1"], gymId, missingTable)).size, 0);
    assert.equal((await renewalsForMemberships([], gymId, client)).size, 0, "nothing to look up");
});
