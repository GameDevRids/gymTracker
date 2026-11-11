import test from "node:test";
import assert from "node:assert/strict";
import { buildUpiLink, formatUpiAmount, isValidUtr, upiIdProblem, upiNote } from "../../assets/js/upi.js";
import { validatePaymentPayload } from "../middleware/validatePayment.js";
import { validateGymSettings } from "../middleware/validateGymSettings.js";
import { createPayment, getReceipt, listPayments } from "../services/paymentsService.js";

const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
const memberId = "00000000-0000-4000-8000-000000000001";
const paymentId = "00000000-0000-4000-8000-0000000000f1";

// ---------- UPI link building ----------

test("the UPI link has pa, pn, am (2 decimals), cu=INR and tn, in that order", () => {
    assert.equal(
        buildUpiLink({ upiId: "powergym@okicici", payeeName: "Power Gym", amount: 1100, note: "Power Gym, GP-ABC123, Monthly" }),
        "upi://pay?pa=powergym@okicici&pn=Power%20Gym&am=1100.00&cu=INR&tn=Power%20Gym%2C%20GP-ABC123%2C%20Monthly"
    );
});

test("names with special characters are encoded and decode back exactly", () => {
    const payeeName = "Shri Ram & Sons #1 Gym = 100%";
    const note = "शक्ती फिटनेस, GP-7F3A, त्रैमासिक?";
    const link = buildUpiLink({ upiId: "shri.ram-gym_1@ybl", payeeName, amount: 499.5, note });
    assert.doesNotMatch(link, /\s/);
    for (const raw of ["&", "#", " ", "?"]) assert.ok(!link.split("?")[1].split("&").some((pair) => pair.split("=")[1].includes(raw)), `raw ${JSON.stringify(raw)} left in a value`);
    const params = Object.fromEntries(link.split("?")[1].split("&").map((pair) => pair.split("=").map(decodeURIComponent)));
    assert.deepEqual(params, { pa: "shri.ram-gym_1@ybl", pn: payeeName, am: "499.50", cu: "INR", tn: note });
});

test("amounts always have exactly two decimals and must be positive", () => {
    assert.equal(formatUpiAmount(1), "1.00");
    assert.equal(formatUpiAmount("1100"), "1100.00");
    assert.equal(formatUpiAmount(1100.5), "1100.50");
    assert.equal(formatUpiAmount(99.999), "100.00");
    assert.equal(formatUpiAmount(0.015), "0.02");
    for (const bad of [0, -5, "abc", "", null, Number.NaN, Infinity]) {
        assert.throws(() => formatUpiAmount(bad), /greater than zero/, String(bad));
        assert.throws(() => buildUpiLink({ upiId: "gym@upi", amount: bad }), /greater than zero/);
    }
});

test("a missing or invalid UPI ID gives no link, and the payee name and note are optional", () => {
    for (const upiId of [undefined, null, "", "   "]) assert.throws(() => buildUpiLink({ upiId, amount: 100 }), /Set the gym's UPI ID in Settings/);
    for (const upiId of ["power gym@okicici", "powergym", "@okicici", "powergym@", "power@gym@x", "p@1bank"]) {
        assert.throws(() => buildUpiLink({ upiId, amount: 100 }), /not valid/, upiId);
    }
    assert.equal(buildUpiLink({ upiId: "gym@upi", amount: 5 }), "upi://pay?pa=gym@upi&am=5.00&cu=INR");
});

test("UPI ID and UTR checks match what the database allows", () => {
    assert.equal(upiIdProblem(""), "");
    assert.equal(upiIdProblem("powergym@okicici"), "");
    assert.equal(upiIdProblem("9876543210@paytm"), "");
    assert.match(upiIdProblem("power gym@okicici"), /no spaces/);
    assert.match(upiIdProblem("powergym"), /like powergym@okicici/);
    assert.equal(isValidUtr("123456789012"), true);
    for (const bad of ["12345678901", "1234567890123", "12345678901a", "", null]) assert.equal(isValidUtr(bad), false);
});

test("the note is gym name, member code and plan, kept short", () => {
    assert.equal(upiNote({ gymName: "Power Gym", memberCode: "GP-1", planName: "Monthly" }), "Power Gym, GP-1, Monthly");
    assert.equal(upiNote({ gymName: "Power Gym", planName: "Monthly" }), "Power Gym, Monthly");
    const long = upiNote({ gymName: "Shri Hanuman Vyayam Shala and Fitness Centre", memberCode: "GP-7F3A2C91B4D0", planName: "Annual Platinum" });
    assert.equal(long.length, 50);
    assert.match(long, /…$/);
});

// ---------- Request validation ----------

function invoke(middleware, body) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
    const request = { body };
    let nextCalled = false;
    middleware(request, response, () => { nextCalled = true; });
    return { response, nextCalled, request };
}

const validPayment = { member_id: memberId, amount: 1100, method: "upi", paid_on: "2026-11-12" };

test("payment amounts must be positive", () => {
    for (const amount of [0, -1, -0.01, "abc", null]) {
        const result = invoke(validatePaymentPayload, { ...validPayment, amount });
        assert.equal(result.nextCalled, false, String(amount));
        assert.match(result.response.body.message, /greater than zero/);
    }
    assert.equal(invoke(validatePaymentPayload, { ...validPayment, amount: "0.01" }).nextCalled, true);
});

test("the UTR is optional, 12 digits, UPI only, and the receipt number cannot be sent", () => {
    const ok = invoke(validatePaymentPayload, { ...validPayment, upi_reference: "1234 5678 9012" });
    assert.equal(ok.nextCalled, true);
    assert.equal(ok.request.validatedPayment.upi_reference, "123456789012");
    assert.equal(invoke(validatePaymentPayload, { ...validPayment, upi_reference: "" }).request.validatedPayment.upi_reference, null);
    assert.match(invoke(validatePaymentPayload, { ...validPayment, upi_reference: "12345" }).response.body.message, /12 digits/);
    assert.match(invoke(validatePaymentPayload, { ...validPayment, method: "cash", upi_reference: "123456789012" }).response.body.message, /only be recorded on a UPI payment/);
    assert.equal(invoke(validatePaymentPayload, { ...validPayment, receipt_number: "R-000001" }).nextCalled, false);
});

test("gym settings accept a valid UPI ID and reject bad ones and unknown fields", () => {
    const ok = invoke(validateGymSettings, { name: "Power Gym", phone: "98230 12345", upi_id: "powergym@okicici", upi_payee_name: "Power Gym", address: "" });
    assert.equal(ok.nextCalled, true);
    assert.deepEqual(ok.request.validatedSettings, { name: "Power Gym", phone: "98230 12345", upi_id: "powergym@okicici", upi_payee_name: "Power Gym", address: null });
    assert.match(invoke(validateGymSettings, { upi_id: "power gym@okicici" }).response.body.message, /no spaces/);
    assert.match(invoke(validateGymSettings, { upi_id: "powergym" }).response.body.message, /powergym@okicici/);
    assert.equal(invoke(validateGymSettings, { gym_id: gymB }).nextCalled, false);
    assert.equal(invoke(validateGymSettings, { phone: "12" }).nextCalled, false);
});

// ---------- Service: gym isolation and errors ----------

function mockClient(tables = {}, { insertError = null } = {}) {
    const calls = [];
    return {
        calls,
        from(table) {
            const call = { table, operations: [] };
            calls.push(call);
            const query = {};
            for (const method of ["select", "eq", "in", "is", "gte", "order", "range", "insert"]) {
                query[method] = (...args) => { call.operations.push([method, ...args]); return query; };
            }
            const rows = () => (tables[table] || []).filter((row) => call.operations.every(([method, field, value]) => {
                if (method === "eq") return row[field] === value;
                if (method === "in") return value.includes(row[field]);
                return true;
            }));
            const inserted = () => call.operations.find(([method]) => method === "insert")?.[1];
            query.maybeSingle = () => Promise.resolve({ data: rows()[0] || null, error: null });
            query.single = () => Promise.resolve(insertError ? { data: null, error: insertError } : { data: { id: "new", receipt_number: "R-000009", ...inserted() }, error: null });
            query.then = (resolve, reject) => Promise.resolve({ data: rows(), count: rows().length, error: null }).then(resolve, reject);
            return query;
        }
    };
}

test("gym A cannot read gym B's payments or receipts", async () => {
    const tables = {
        payments: [
            { id: "pa", gym_id: gymA, member_id: memberId, amount: "100.00", receipt_number: "R-000001" },
            { id: paymentId, gym_id: gymB, member_id: memberId, amount: "900.00", receipt_number: "R-000001" }
        ],
        members: [{ id: memberId, gym_id: gymA, full_name: "Riya Shah", member_code: "GP-1" }]
    };
    const client = mockClient(tables);
    await assert.rejects(getReceipt(paymentId, gymA, client), (error) => error.status === 404);
    assert.equal(client.calls.filter((call) => call.table !== "payments").length, 0, "nothing else is read for another gym's payment");

    const list = await listPayments({ page: 1, limit: 50 }, gymA, mockClient(tables), new Date("2026-11-12T10:00:00+05:30"));
    assert.deepEqual(list.payments.map((row) => row.id), ["pa"]);
    assert.equal(list.monthTotal, 100);
    await assert.rejects(listPayments({}, null, mockClient(tables)), (error) => error.status === 403);
});

test("a receipt shows the balance as it stood just after that payment", async () => {
    const membershipId = "ms-1";
    const tables = {
        payments: [
            { id: "p1", gym_id: gymA, member_id: memberId, membership_id: membershipId, amount: "400.00", method: "cash", receipt_number: "R-000004" },
            { id: "p2", gym_id: gymA, member_id: memberId, membership_id: membershipId, amount: "300.00", method: "upi", upi_reference: "123456789012", receipt_number: "R-000007" },
            { id: "p3", gym_id: gymA, member_id: memberId, membership_id: membershipId, amount: "400.00", method: "upi", receipt_number: "R-000011" }
        ],
        members: [{ id: memberId, gym_id: gymA, full_name: "Riya Shah", member_code: "GP-1", phone: "9876543210", whatsapp_opt_in: true }],
        member_memberships: [{ id: membershipId, gym_id: gymA, plan_name: "Monthly", start_date: "2026-11-12", end_date: "2026-12-11", price: 1100, total_fees: 1100 }],
        gyms: [{ id: gymA, name: "Power Gym" }],
        gym_settings: [{ gym_id: gymA, phone: "98230 12345", upi_id: "powergym@okicici" }]
    };
    const second = await getReceipt("p2", gymA, mockClient(tables));
    assert.equal(second.payment.receipt_number, "R-000007");
    assert.equal(second.paid_to_date, 700);
    assert.equal(second.balance, 400);
    assert.deepEqual(second.gym, { name: "Power Gym", phone: "98230 12345", address: null });
    assert.equal(second.membership.end_date, "2026-12-11");
    const last = await getReceipt("p3", gymA, mockClient(tables));
    assert.equal(last.balance, 0);
});

test("the receipt number is never taken from the request, and a reused UTR is reported clearly", async () => {
    const tables = { members: [{ id: memberId, gym_id: gymA }] };
    const client = mockClient(tables);
    await createPayment({ ...validPayment, receipt_number: "R-999999" }, gymA, client);
    const insert = client.calls.find((call) => call.table === "payments").operations.find(([method]) => method === "insert")[1];
    assert.equal("receipt_number" in insert, false);
    assert.equal(insert.gym_id, gymA);

    const duplicate = mockClient(tables, { insertError: { code: "23505", message: 'duplicate key value violates unique constraint "payments_gym_upi_reference_key"' } });
    await assert.rejects(createPayment({ ...validPayment, upi_reference: "123456789012" }, gymA, duplicate), (error) => error.status === 409 && /UTR\) is already recorded/.test(error.message));
});
