// Payments above the database (migration 025 is covered by payment-rules-migration.test.js): the shared
// rules the Record payment form uses (balance due, which plan, the 10-minute duplicate warning, error
// wording), the API (request key and plan required, owner-only void, refusals with what is due), receipts
// (VOID, nothing sent), balances and exports leaving voided payments out, and the import check.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { inflateRawSync } from "node:zlib";
import { installPhotoDom } from "./helpers/fakeDom.js";
import {
    amountProblem, balancesDue, chooseMembership, countsTowardPlan, duplicateQuestion, newRequestKey, recentDuplicate, rejectionMessage, rupees
} from "../../assets/js/paymentRules.js";
import { welcomePayment } from "../../assets/js/welcomeMessage.js";
import { createPayment, getReceipt, voidPayment } from "../services/paymentsService.js";
import { memberBilling } from "../services/membersService.js";
import { buildGymWorkbook } from "../services/exportService.js";
import { importMembers } from "../services/memberImportService.js";
import { readSpreadsheet } from "../../assets/js/spreadsheet.js";
import paymentsRouter from "../routes/payments.js";

const gymA = "00000000-0000-4000-8000-0000000000a1";
const memberId = "00000000-0000-4000-8000-000000000001";
const planId = "00000000-0000-4000-8000-0000000000c1";
const requestKey = "00000000-0000-4000-8000-0000000000d1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOW = Date.parse("2026-11-17T10:00:00Z");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60000).toISOString();

// ---------- Shared rules (the form) ----------

const plan = (id, start, fee, extra = {}) => ({ id, start_date: start, end_date: start, plan_name: id, price: fee, total_fees: fee, status: "assigned", ...extra });
const pay = (membershipId, amount, extra = {}) => ({ membership_id: membershipId, amount, kind: "plan", status: "paid", created_at: minutesAgo(60), ...extra });

test("balance due per plan = fee (after discount) − plan payments that are not voided; hold fees don't count", () => {
    const rows = balancesDue(
        [plan("b", "2026-11-01", 900, { price: 1000 }), plan("a", "2026-10-01", 1000), plan("x", "2026-09-01", 500, { status: "cancelled" })],
        [pay("a", 600), pay("a", 400, { status: "voided" }), pay("a", 200, { kind: "hold_fee" }), pay("b", 900)]
    );
    assert.deepEqual(rows.map((row) => [row.membership.id, row.fee, row.paid, row.balance]), [["a", 1000, 600, 400], ["b", 900, 900, 0]], "oldest first; the cancelled plan is left out");
    assert.equal(countsTowardPlan({ kind: "hold_fee" }), false);
    assert.equal(countsTowardPlan({ status: "voided" }), false);
    assert.equal(countsTowardPlan({}), true, "older rows without kind or status are plan payments");
});

test("which plan the form is for: the one asked for if it owes, otherwise the oldest that owes; none when fully paid", () => {
    const rows = balancesDue([plan("old", "2026-09-01", 1000), plan("new", "2026-11-01", 1000)], [pay("old", 500)]);
    assert.equal(chooseMembership(rows, "new").selected.membership.id, "new");
    assert.equal(chooseMembership(rows, "missing").selected.membership.id, "old");
    assert.equal(chooseMembership(rows, "").owing.length, 2, "two plans owe: the form shows a plan picker");
    const paid = balancesDue([plan("p", "2026-11-01", 1000)], [pay("p", 1000)]);
    assert.deepEqual(chooseMembership(paid, "p"), { selected: null, owing: [] }, "fully paid: no form, the paid status instead");
});

test("the amount can't be more than the balance due, and nothing can be paid at 0", () => {
    assert.equal(amountProblem(400, 400), "");
    assert.equal(amountProblem(250.5, 400), "");
    assert.equal(amountProblem(401, 400), "Only ₹400 is due.");
    assert.equal(amountProblem(1001, 1000), "Only ₹1,000 is due.");
    assert.equal(amountProblem(100, 0), "Already fully paid.");
    assert.equal(amountProblem(0, 400), "Enter an amount greater than zero.");
    assert.equal(amountProblem("", 400), "Enter an amount greater than zero.");
    assert.equal(rupees(1250.5), "₹1,250.50");
    assert.equal(rupees(125000), "₹1,25,000");
});

test("duplicate warning: the same amount for the member within 10 minutes (not voided)", () => {
    const earlier = [
        pay("a", 1000, { created_at: minutesAgo(3) }),
        pay("a", 500, { created_at: minutesAgo(2), status: "voided" }),
        pay("a", 750, { created_at: minutesAgo(11) }),
        pay("a", 200, { created_at: minutesAgo(1), kind: "hold_fee" })
    ];
    assert.equal(recentDuplicate(earlier, { amount: 1000, now: NOW }).amount, 1000);
    assert.equal(recentDuplicate(earlier, { amount: "1000.00", now: NOW }).amount, 1000);
    assert.equal(recentDuplicate(earlier, { amount: 500, now: NOW }), null, "a voided payment is not a duplicate");
    assert.equal(recentDuplicate(earlier, { amount: 750, now: NOW }), null, "more than 10 minutes ago");
    assert.equal(recentDuplicate(earlier, { amount: 200, now: NOW }), null, "a hold fee is not a plan payment");
    assert.equal(recentDuplicate(earlier, { amount: 999, now: NOW }), null);
    assert.equal(duplicateQuestion(earlier[0], "suman", NOW), "You recorded ₹1,000 for suman a few minutes ago. Record it again?");
    assert.equal(duplicateQuestion({ amount: 1000, created_at: minutesAgo(0.2) }, "suman", NOW), "You recorded ₹1,000 for suman just now. Record it again?");
});

test("each server refusal has a clear message", () => {
    assert.equal(rejectionMessage({ code: "fully_paid" }), "Already fully paid. Nothing more is due on this plan.");
    assert.equal(rejectionMessage({ code: "over_balance", details: { balance_due: 600 } }), "Only ₹600 is due.");
    assert.equal(rejectionMessage({ code: "membership_required" }), "Choose the plan this payment is for.");
    assert.equal(rejectionMessage({ code: "utr_taken" }), "This UPI reference (UTR) is already recorded for another payment.");
    assert.equal(rejectionMessage({ message: "Something else." }), "Something else.");
});

test("a request key per form is a UUID, with or without crypto.randomUUID", () => {
    assert.match(newRequestKey(), UUID);
    const saved = globalThis.crypto.randomUUID;
    try {
        Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
        const keys = new Set(Array.from({ length: 50 }, newRequestKey));
        assert.equal(keys.size, 50);
        for (const key of keys) assert.match(key, UUID);
    } finally {
        Object.defineProperty(globalThis.crypto, "randomUUID", { value: saved, configurable: true });
    }
});

test("the welcome message's balance leaves out hold fees and voided payments", () => {
    const membership = { id: "m", total_fees: 1000 };
    const payment = welcomePayment(membership, [pay("m", 600, { method: "cash" }), pay("m", 400, { status: "voided", method: "cash" }), pay("m", 200, { kind: "hold_fee", method: "cash" })]);
    assert.deepEqual([payment.paid, payment.balance], [600, 400]);
});

// ---------- Service ----------

const rpcClient = (answer) => {
    const calls = [];
    return { calls, rpc: (name, args) => { calls.push([name, args]); return Promise.resolve(typeof answer === "function" ? answer(name, args) : answer); } };
};
const input = { member_id: memberId, membership_id: planId, amount: 1000, method: "cash", paid_on: "2026-11-17", idempotency_key: requestKey };

test("refusals from the database become clear answers with what is due", async () => {
    const refuse = (error) => createPayment(input, { gymId: gymA }, rpcClient({ data: null, error }));
    await assert.rejects(refuse({ code: "P0001", message: "Already fully paid.", details: "fully_paid", hint: "0" }),
        (error) => error.status === 409 && error.reason === "fully_paid" && error.message === "Already fully paid." && error.extra.balance_due === 0);
    await assert.rejects(refuse({ code: "P0001", message: "Only ₹1000 is due.", details: "over_balance", hint: "1000.00" }),
        (error) => error.status === 409 && error.reason === "over_balance" && error.message === "Only ₹1,000 is due." && error.extra.balance_due === 1000);
    await assert.rejects(refuse({ code: "P0002", message: "Member not found." }), (error) => error.status === 404);
    await assert.rejects(refuse({ code: "PGRST202", message: "function not found" }), (error) => error.status === 503 && /025_payment_rules_and_void/.test(error.message));
    await assert.rejects(createPayment({ ...input, idempotency_key: undefined }, { gymId: gymA }, rpcClient({})), (error) => error.status === 400);
    await assert.rejects(createPayment({ ...input, membership_id: null }, { gymId: gymA }, rpcClient({})), (error) => error.status === 400 && /Choose the plan/.test(error.message));
});

test("a repeated request answers with the first payment, marked replayed", async () => {
    const saved = { id: "p1", receipt_number: "R-000002", amount: 1000 };
    const client = rpcClient({ data: { replayed: true, balance_due: 0, payment: saved }, error: null });
    assert.deepEqual(await createPayment(input, { gymId: gymA, userId: "u1" }, client), { payment: saved, balance_due: 0, replayed: true });
    assert.equal(client.calls[0][1].p_idempotency_key, requestKey);
    assert.equal(client.calls[0][1].p_recorded_by, "u1");
});

test("voiding passes who voided it, and says when it was already voided", async () => {
    const client = rpcClient((name, args) => (args.p_payment_id === "done"
        ? { data: null, error: { code: "P0001", message: "This payment is already voided.", details: "already_voided" } }
        : { data: { payment: { id: args.p_payment_id, status: "voided", voided_by: null }, balance_due: "1000.00" }, error: null }));
    const result = await voidPayment("p1", "Recorded twice", { gymId: gymA, userId: "owner-1" }, client);
    assert.deepEqual(client.calls[0], ["gympulse_void_payment", { p_gym_id: gymA, p_payment_id: "p1", p_reason: "Recorded twice", p_by: "owner-1" }]);
    assert.equal(result.balance_due, 1000);
    await assert.rejects(voidPayment("done", "Again", { gymId: gymA, userId: "owner-1" }, client), (error) => error.status === 409 && error.reason === "already_voided");
});

// ---------- API ----------

async function call(method, path, body, { role = "owner" } = {}) {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.gymId = gymA; request.gymRole = role; request.authUser = { id: "u1" }; next(); });
    app.use("/api/payments", paymentsRouter);
    const server = app.listen(0);
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, body: await response.json() };
    } finally {
        server.close();
    }
}

test("API: a payment needs a plan and a request key; the gym comes from the sign-in", async () => {
    const without = (field) => { const body = { ...input }; delete body[field]; return body; };
    assert.equal((await call("POST", "/api/payments", without("idempotency_key"))).body.message, "Refresh the app and try again (the request had no key).");
    assert.equal((await call("POST", "/api/payments", without("membership_id"))).body.message, "Choose the plan this payment is for.");
    assert.equal((await call("POST", "/api/payments", { ...input, gym_id: "00000000-0000-4000-8000-0000000000b1" })).status, 400, "a gym_id in the body is refused");
});

test("API: only the owner can void, and only with a reason", async () => {
    const staff = await call("POST", `/api/payments/${requestKey}/void`, { reason: "Recorded twice" }, { role: "staff" });
    assert.deepEqual([staff.status, staff.body.message], [403, "Only the gym owner can void a payment."]);
    assert.equal((await call("POST", `/api/payments/${requestKey}/void`, {})).status, 400);
    assert.equal((await call("POST", `/api/payments/${requestKey}/void`, { reason: "ok" })).body.message, "Give a reason for voiding (3 to 300 characters).");
    assert.equal((await call("POST", "/api/payments/not-a-uuid/void", { reason: "Recorded twice" })).status, 400);
    const owner = await call("POST", `/api/payments/${requestKey}/void`, { reason: "Recorded twice" });
    assert.notEqual(owner.status, 403, "the owner gets past the check (no database in this test)");
});

// ---------- Receipts, balances, exports, import ----------

function tableClient(tables) {
    return {
        rpc: () => Promise.resolve({ data: null, error: null }),
        auth: { admin: { getUserById: async () => ({ data: { user: { email: "o@gym.in" } } }) } },
        from(table) {
            const ops = [];
            const query = {};
            for (const name of ["select", "eq", "in", "is", "gte", "order", "range"]) query[name] = (...args) => { ops.push([name, ...args]); return query; };
            const rows = () => (tables[table] || []).filter((row) => ops.every(([name, field, value]) => (name === "eq" ? row[field] === value : name === "in" ? value.includes(row[field]) : true)));
            query.maybeSingle = () => Promise.resolve({ data: rows()[0] || null, error: null });
            query.then = (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
            return query;
        }
    };
}

test("a voided payment's receipt says so and has no balance; later receipts don't count it", async () => {
    const tables = {
        payments: [
            { id: "p1", gym_id: gymA, member_id: memberId, membership_id: "ms", amount: 1000, receipt_number: "R-000002", kind: "plan", status: "paid" },
            { id: "p2", gym_id: gymA, member_id: memberId, membership_id: "ms", amount: 1000, receipt_number: "R-000003", kind: "plan", status: "voided", voided_by: "owner-1", voided_at: "2026-11-17T06:00:00Z", void_reason: "Recorded twice" }
        ],
        members: [{ id: memberId, gym_id: gymA, full_name: "suman", phone: "9876543210", whatsapp_opt_in: true }],
        member_memberships: [{ id: "ms", gym_id: gymA, plan_name: "Monthly", total_fees: 1000, price: 1000 }],
        gym_users: [{ gym_id: gymA, user_id: "owner-1", role: "owner" }]
    };
    const voided = await getReceipt("p2", gymA, tableClient(tables));
    assert.equal(voided.voided, true);
    assert.equal(voided.balance, null);
    assert.deepEqual(voided.payment.voided_by_name, { role: "Owner", email: "o@gym.in" });
    const kept = await getReceipt("p1", gymA, tableClient(tables));
    assert.deepEqual([kept.voided, kept.paid_to_date, kept.balance], [false, 1000, 0]);
});

test("member balances leave voided payments out (Members list, profile, export)", () => {
    assert.deepEqual(memberBilling([{ total_fees: 1000 }], [{ amount: 1000, kind: "plan" }, { amount: 1000, kind: "plan", status: "voided" }]), { billed: 1000, paid: 1000, outstanding: 0 });
    assert.deepEqual(memberBilling([{ total_fees: 1000 }], [{ amount: 1000, kind: "plan", status: "voided" }]), { billed: 1000, paid: 0, outstanding: 1000 }, "the balance due goes back up");
});

test("the export lists voided payments, marked Voided with when and why", async () => {
    const tables = {
        members: [{ gym_id: gymA, id: memberId, member_code: "GP-1", full_name: "suman", phone: "9876543210", status: "active", created_at: "2026-11-01T05:00:00Z" }],
        member_memberships: [{ gym_id: gymA, id: "ms", member_id: memberId, plan_name: "Monthly", duration_days: 30, price: 1000, total_fees: 1000, start_date: "2026-11-01", end_date: "2026-11-30", status: "assigned", created_at: "2026-11-01T05:00:00Z" }],
        payments: [
            { gym_id: gymA, id: "p1", member_id: memberId, receipt_number: "R-000002", amount: 1000, method: "cash", paid_on: "2026-11-17", kind: "plan", status: "paid", created_at: "2026-11-17T05:00:00Z" },
            { gym_id: gymA, id: "p2", member_id: memberId, receipt_number: "R-000003", amount: 1000, method: "cash", paid_on: "2026-11-17", kind: "plan", status: "voided", voided_at: "2026-11-17T06:00:00Z", void_reason: "Recorded twice", created_at: "2026-11-17T05:01:00Z" }
        ],
        attendance: []
    };
    const db = {
        from(table) {
            const filters = {};
            const builder = { select: () => builder, eq: (column, value) => { filters[column] = value; return builder; }, order: () => builder, in: () => builder,
                range: async (from, to) => ({ data: (tables[table] || []).filter((row) => row.gym_id === filters.gym_id).slice(from, to + 1), error: null }),
                then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve) };
            return builder;
        }
    };
    const bytes = await buildGymWorkbook(gymA, db, "2026-11-17");
    const { sheets } = await readSpreadsheet("export.xlsx", bytes, { inflateRaw: async (data) => new Uint8Array(inflateRawSync(data)) });
    const cell = (value) => (value && typeof value === "object" ? value.text ?? value.value ?? "" : value);
    const [header, ...rows] = sheets.find((sheet) => sheet.name === "Payments").rows.map((row) => row.map(cell));
    const byReceipt = Object.fromEntries(rows.map((row) => [row[0], Object.fromEntries(header.map((name, i) => [name, row[i]]))]));
    assert.equal(byReceipt["R-000002"].Status, "Paid");
    assert.equal(byReceipt["R-000003"].Status, "Voided");
    assert.match(byReceipt["R-000003"].Voided, /Recorded twice/);
    const [memberHeader, memberRow] = sheets[0].rows.map((row) => row.map(cell));
    assert.equal(String(memberRow[memberHeader.indexOf("Balance (₹)")]), "0", "the voided duplicate doesn't make a credit; ₹1,000 paid on ₹1,000");
    assert.equal(String(memberRow[memberHeader.indexOf("Paid (₹)")]), "1000");
});

test("an import row paying more than its plan's price is refused with its row number, before anything is saved", async () => {
    let saved = false;
    const client = {
        rpc: () => { saved = true; return Promise.resolve({ data: {}, error: null }); },
        from: () => ({ select() { return this; }, eq() { return this; }, in() { return Promise.resolve({ data: [{ id: planId, price: 1000 }], error: null }); } })
    };
    await assert.rejects(importMembers({ new_plans: [], rows: [{ row: 4, plan: { id: planId }, amount_paid: 1200 }] }, gymA, client),
        (error) => error.status === 400 && error.message === "Nothing was saved. Row 4: the amount paid (₹1,200) is more than the plan's price (₹1,000).");
    await assert.rejects(importMembers({ new_plans: [{ ref: "n1", price: 500 }], rows: [{ row: 5, plan: { ref: "n1" }, amount_paid: 600 }] }, gymA, client), /Row 5/);
    assert.equal(saved, false);
    await importMembers({ new_plans: [], rows: [{ row: 4, plan: { id: planId }, amount_paid: 1000 }] }, gymA, client);
    assert.equal(saved, true, "exactly the price is fine");
});

// ---------- Screens: the receipt and the Payments page ----------

const dialog = { html: "" };
function stub() {
    return { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => stub(), querySelectorAll: () => [], addEventListener() {}, focus() {}, append() {}, remove() {}, setAttribute() {}, replaceChildren() {} };
}
const modalRoot = { ...stub(), get innerHTML() { return dialog.html; }, set innerHTML(html) { dialog.html = html; }, replaceChildren() { dialog.html = ""; } };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const boot = installPhotoDom();
Object.assign(globalThis.document, { activeElement: null, querySelector: (selector) => (selector === "#modal-root" ? modalRoot : stub()), createElement: () => stub() });
const upi = await import("../../assets/js/modules/upiPayments.js");
const { renderOperationsPage } = await import("../../assets/js/modules/operations.js");
const { state } = await import("../../assets/js/state.js");
boot.restore();

test("a voided payment's receipt shows VOID and offers no WhatsApp sending", async () => {
    const receipt = {
        payment: { id: "p2", receipt_number: "R-000003", amount: 1000, method: "cash", paid_on: "2026-11-17", kind: "plan", status: "voided", voided_at: "2026-11-17T06:00:00Z", void_reason: "Recorded twice", voided_by_name: { role: "Owner", email: "o@gym.in" } },
        voided: true, member: { full_name: "suman", phone: "9876543210", whatsapp_opt_in: true, member_code: "GP-1" },
        membership: { plan_name: "Monthly", end_date: "2026-11-30" }, fee: null, paid_to_date: null, balance: null, gym: { name: "Power Gym" }
    };
    const dom = installPhotoDom();
    Object.assign(globalThis.document, { activeElement: null, querySelector: (selector) => (selector === "#modal-root" ? modalRoot : stub()), createElement: () => stub() });
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ status: "success", data: receipt }) });
    try {
        await upi.openReceiptDialog("p2");
    } finally {
        dom.restore();
    }
    assert.match(dialog.html, /receipt-void-stamp[^>]*>VOID</);
    assert.match(dialog.html, /Voided 17 Nov 2026 by Owner \(o@gym\.in\): Recorded twice/);
    assert.doesNotMatch(dialog.html, /data-action="receipt-text"|data-action="receipt-share"/, "no way to send it");
    assert.match(upi.receiptText(receipt), /VOID: this payment was cancelled/);
});

test("the Payments page marks voided payments; only the owner sees Void, and not on a voided one", () => {
    Object.assign(upi.paymentsPage, { status: "ready", loaded: true, total: 2, monthTotal: 1000, payments: [
        { id: "p1", receipt_number: "R-000002", amount: 1000, method: "cash", paid_on: "2026-11-17", kind: "plan", status: "paid", member: { full_name: "suman", member_code: "GP-1" } },
        { id: "p2", receipt_number: "R-000003", amount: 1000, method: "cash", paid_on: "2026-11-17", kind: "plan", status: "voided", voided_at: "2026-11-17T06:00:00Z", void_reason: "Recorded twice", member: { full_name: "suman", member_code: "GP-1" } }
    ] });
    state.gym.role = "owner";
    const ownerView = renderOperationsPage("payments");
    assert.match(ownerView, /data-action="payment-void" data-id="p1"/);
    assert.doesNotMatch(ownerView, /data-action="payment-void" data-id="p2"/);
    assert.match(ownerView, /class="is-voided"[^>]*>.*R-000003/s);
    assert.match(ownerView, /<s class="voided-amount">₹1,000<\/s> <span class="status status-voided">Voided<\/span>/);
    assert.match(ownerView, /Voided 17 Nov 2026: Recorded twice/);
    state.gym.role = "staff";
    assert.doesNotMatch(renderOperationsPage("payments"), /data-action="payment-void"/, "staff can't void");
    state.gym.role = "owner";
});
