// Runs migration 025 in real Postgres (PGlite): payments can't go over the balance due (Record payment,
// Renew, import, hold fees), one payment per request key, voiding (reason, once, final, left out of
// balances and money collected), receipt numbers, gym isolation, the read-only overpaid query, and
// that the plan row is locked while a payment is checked.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createMigratedDatabase, applyMigration } from "./helpers/database.js";

const owner = "00000000-0000-4000-8000-00000000000a";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
let db;
let today;
let monthly;
let phones = 0;
let keys = 0;
const key = () => `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`;
const shift = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

// A member with a ₹1,000 monthly plan (optionally something already paid by import).
async function member(gym = gymA, { paid = null, start = 0 } = {}) {
    phones += 1;
    const phone = `98760${String(phones).padStart(5, "0")}`;
    const plan = gym === gymA ? monthly : (await db.query("SELECT id FROM public.membership_plans WHERE gym_id = $1 LIMIT 1", [gym])).rows[0].id;
    await db.query("SELECT public.gympulse_import_members($1, $2::jsonb)", [gym, JSON.stringify({ rows: [{
        row: 2, full_name: `Member ${phones}`, phone, notes: null, plan: { id: plan }, start_date: shift(today, start), end_date: shift(today, start + 29), amount_paid: paid }] })]);
    const row = (await db.query("SELECT m.id, mm.id AS mm FROM public.members m JOIN public.member_memberships mm ON mm.member_id = m.id WHERE m.gym_id = $1 AND m.phone = $2", [gym, phone])).rows[0];
    return { id: row.id, mm: row.mm };
}
const record = (m, amount, { gym = gymA, mm = m.mm, requestKey = key(), method = "cash" } = {}) => db.query(
    "SELECT public.gympulse_record_payment($1, $2, $3, $4, $5, $6, null, null, $7, $8) AS r",
    [gym, m.id, mm, amount, method, today, requestKey, owner]).then((result) => result.rows[0].r);
const voidIt = (paymentId, reason = "Recorded twice", gym = gymA) => db.query(
    "SELECT public.gympulse_void_payment($1, $2, $3, $4) AS r", [gym, paymentId, reason, owner]).then((result) => result.rows[0].r);
const balance = async (m) => Number((await db.query("SELECT public.gympulse_membership_balance($1, $2) AS b", [gymA, m.mm])).rows[0].b);
const paymentsOf = async (m) => (await db.query("SELECT id, amount::float AS amount, status, receipt_number FROM public.payments WHERE member_id = $1 ORDER BY receipt_number", [m.id])).rows;

before(async () => {
    db = await createMigratedDatabase();
    today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).rows[0].d;
    await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${owner}', 'o@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'A', '${owner}'), ('${gymB}', 'B', '${owner}');`);
    monthly = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 1000) RETURNING id", [gymA])).rows[0].id;
    await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly B', 30, 1000)", [gymB]);
});

test("migration 025 runs twice without errors", async () => {
    await applyMigration(db, "025_payment_rules_and_void.sql");
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'payments' AND column_name IN ('status', 'voided_at', 'voided_by', 'void_reason', 'idempotency_key', 'recorded_by')")).rows;
    assert.equal(columns.length, 6);
});

test("nothing due: 'Already fully paid'", async () => {
    const m = await member(gymA, { paid: 1000 });
    await assert.rejects(record(m, 1), /Already fully paid/);
    await assert.rejects(record(m, 1000), /Already fully paid/);
    assert.equal((await paymentsOf(m)).length, 1);
});

test("more than is due: 'Only ₹X is due'; part payments are fine until the balance is 0", async () => {
    const m = await member();
    await assert.rejects(record(m, 1000.01), /Only ₹1000 is due/);
    assert.equal(Number((await record(m, 400)).balance_due), 600);
    await assert.rejects(record(m, 601), /Only ₹600 is due/);
    assert.equal(Number((await record(m, 350.5)).balance_due), 249.5);
    await assert.rejects(record(m, 250), /Only ₹249.50 is due/);
    assert.equal(Number((await record(m, 249.5)).balance_due), 0);
    await assert.rejects(record(m, 0.01), /Already fully paid/);
    assert.equal(await balance(m), 0);
});

test("the refusal says how much is due, for the app to show", async () => {
    const m = await member(gymA, { paid: 300 });
    try {
        await record(m, 900);
        assert.fail("should be refused");
    } catch (error) {
        assert.equal(error.detail, "over_balance");
        assert.equal(Number(error.hint), 700);
    }
});

test("the same request key twice (a double tap or a retry) creates one payment and returns the first", async () => {
    const m = await member();
    const requestKey = key();
    const first = await record(m, 500, { requestKey });
    const again = await record(m, 500, { requestKey });
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.equal(again.payment.id, first.payment.id);
    assert.equal((await paymentsOf(m)).length, 1);
    // A different amount with the same key still returns the first payment, not a second one.
    assert.equal((await record(m, 100, { requestKey })).payment.id, first.payment.id);
    const other = await member();
    await assert.rejects(record(other, 100, { requestKey }), /belongs to another member/);
});

test("two saves for the same plan wait for each other: the plan row is locked while the payment is checked", async () => {
    const m = await member();
    await db.exec("BEGIN");
    try {
        await record(m, 600);
        const locks = (await db.query(`SELECT mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
            WHERE c.relname = 'member_memberships' AND l.pid = pg_backend_pid()`)).rows.map((row) => row.mode);
        assert.ok(locks.includes("RowShareLock"), `FOR UPDATE was taken on the plan (locks: ${locks.join(", ")})`);
        // The second save, after the first, sees it: only ₹400 is left.
        await assert.rejects(record(m, 600), /Only ₹400 is due/);
    } finally {
        await db.exec("ROLLBACK");
    }
    assert.equal((await paymentsOf(m)).length, 0, "the rolled-back payment left nothing behind");
});

test("every payment needs a plan of this member; a cancelled plan takes none", async () => {
    const m = await member();
    await assert.rejects(record(m, 100, { mm: null }), /Choose the plan this payment is for/);
    const other = await member();
    await assert.rejects(record(m, 100, { mm: other.mm }), /Membership not found for this member/);
    await db.query("UPDATE public.member_memberships SET status = 'cancelled' WHERE id = $1", [m.mm]);
    await assert.rejects(record(m, 100), /cancelled/);
});

test("another gym can't record or void this gym's payments", async () => {
    const m = await member();
    await assert.rejects(record(m, 100, { gym: gymB }), /Member not found/);
    const { payment } = await record(m, 100);
    await assert.rejects(voidIt(payment.id, "Not mine", gymB), /Payment not found/);
    assert.equal((await paymentsOf(m))[0].status, "paid");
    // Writing straight into the table with another gym's id doesn't get round the rule either.
    await assert.rejects(db.query("INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method) VALUES ($1, $2, $3, 10, 'cash')", [gymB, m.id, m.mm]),
        /Membership not found|violates foreign key/);
});

test("voiding needs a reason, works once, restores the balance and is final", async () => {
    const m = await member(gymA, { paid: 1000 });
    // suman's case: the duplicate got in before 025 (written past the new rule).
    await db.exec("ALTER TABLE public.payments DISABLE TRIGGER payments_within_balance");
    await db.query("INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method, paid_on) VALUES ($1, $2, $3, 1000, 'cash', $4)", [gymA, m.id, m.mm, today]);
    await db.exec("ALTER TABLE public.payments ENABLE TRIGGER payments_within_balance");
    const [first, duplicate] = await paymentsOf(m);
    await assert.rejects(voidIt(duplicate.id, ""), /reason/);
    await assert.rejects(voidIt(duplicate.id, "no"), /reason/);
    const result = await voidIt(duplicate.id, "Recorded twice");
    assert.equal(result.payment.status, "voided");
    assert.equal(result.payment.void_reason, "Recorded twice");
    assert.equal(result.payment.voided_by, owner);
    assert.ok(result.payment.voided_at);
    assert.equal(Number(result.balance_due), 0, "₹1,000 is still paid by the first payment");
    await assert.rejects(voidIt(duplicate.id, "Again"), /already voided/);
    await assert.rejects(db.query("UPDATE public.payments SET status = 'paid', voided_at = null, voided_by = null, void_reason = null WHERE id = $1", [duplicate.id]), /cannot be changed/);
    await assert.rejects(db.query("UPDATE public.payments SET amount = 1 WHERE id = $1", [duplicate.id]), /cannot be changed/);
    await voidIt(first.id, "Cash returned");
    assert.equal(await balance(m), 1000, "the balance due goes back up");
    assert.equal(Number((await record(m, 1000)).balance_due), 0, "and can be paid again");
});

test("voided payments are left out of balances, money collected and renewal results", async () => {
    const m = await member();
    const { payment } = await record(m, 700);
    const before = (await db.query("SELECT public.gympulse_gym_summary($1) AS s", [gymA])).rows[0].s;
    await voidIt(payment.id);
    const after = (await db.query("SELECT public.gympulse_gym_summary($1) AS s", [gymA])).rows[0].s;
    assert.equal(Number(before.collected_this_month) - Number(after.collected_this_month), 700);
    assert.equal(Number(before.collected_all_time) - Number(after.collected_all_time), 700);
    assert.equal(Number(after.outstanding_total) - Number(before.outstanding_total), 700);
    assert.equal(Number(before.months.at(-1).collected) - Number(after.months.at(-1).collected), 700);
    const row = (await db.query("SELECT paid::float, outstanding::float FROM public.member_balances WHERE member_id = $1", [m.id])).rows[0];
    assert.deepEqual(row, { paid: 0, outstanding: 1000 });
});

test("receipt numbers are never reused: refused saves leave no gap and a voided payment keeps its number", async () => {
    const m = await member();
    const counter = async () => Number((await db.query("SELECT last_number FROM public.gym_receipt_counters WHERE gym_id = $1", [gymA])).rows[0].last_number);
    const start = await counter();
    const a = (await record(m, 400)).payment;
    await assert.rejects(record(m, 700), /is due/);
    assert.equal(await counter(), start + 1, "a refused payment uses no number");
    await voidIt(a.id);
    const b = (await record(m, 1000)).payment;
    assert.equal(a.receipt_number, `R-${String(start + 1).padStart(6, "0")}`);
    assert.equal(b.receipt_number, `R-${String(start + 2).padStart(6, "0")}`);
    assert.equal((await paymentsOf(m)).find((row) => row.id === a.id).receipt_number, a.receipt_number);
    await assert.rejects(db.query("DELETE FROM public.payments WHERE id = $1", [a.id]), /cannot be deleted/);
});

test("Renew follows the same rule: it pays at most the new plan's fee, and the payment counts towards it", async () => {
    const m = await member(gymA, { paid: 1000, start: -29 });
    const renew = (amount) => db.query("SELECT public.gympulse_renew_member($1, $2, $3, $4, null, null, null, null, $5, 'cash', null, $6) AS r", [gymA, m.id, key(), monthly, amount, owner]);
    await assert.rejects(renew(1500), /between zero and the fee/);
    const renewed = (await renew(600)).rows[0].r;
    assert.equal(Number(renewed.payment.amount), 600);
    const next = { id: m.id, mm: renewed.membership.id };
    await assert.rejects(record(next, 401), /Only ₹400 is due/);
    assert.equal(Number((await record(next, 400)).balance_due), 0);
});

test("an import can't pay more than its plan's price; a hold fee is its own amount and can be voided", async () => {
    phones += 1;
    await assert.rejects(db.query("SELECT public.gympulse_import_members($1, $2::jsonb)", [gymA, JSON.stringify({ rows: [{
        row: 7, full_name: "Too Much", phone: `98760${String(phones).padStart(5, "0")}`, notes: null, plan: { id: monthly }, start_date: today, end_date: shift(today, 29), amount_paid: 1200 }] })]), /Only ₹1000 is due/);
    // A hold fee does not count towards the plan, so a fully paid plan can still take one.
    const m = await member(gymA, { paid: 1000 });
    const fee = (await db.query("INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method, kind) VALUES ($1, $2, $3, 200, 'cash', 'hold_fee') RETURNING id", [gymA, m.id, m.mm])).rows[0].id;
    assert.equal(await balance(m), 0);
    assert.equal((await voidIt(fee, "Hold not taken")).payment.status, "voided");
    const refunded = (await db.query("INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method, kind, refunded_at) VALUES ($1, $2, $3, 200, 'cash', 'hold_fee', now()) RETURNING id", [gymA, m.id, m.mm])).rows[0].id;
    await assert.rejects(voidIt(refunded, "Already refunded"), /already given back/);
});

test("a new payment can't be saved as voided, and the functions are for the server only", async () => {
    const m = await member();
    await assert.rejects(db.query("INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method, status, voided_at, void_reason) VALUES ($1, $2, $3, 10, 'cash', 'voided', now(), 'test')", [gymA, m.id, m.mm]), /cannot be saved as voided/);
    for (const fn of ["gympulse_record_payment(uuid, uuid, uuid, numeric, text, date, text, text, uuid, uuid)", "gympulse_void_payment(uuid, uuid, text, uuid)", "gympulse_membership_balance(uuid, uuid)"]) {
        for (const role of ["anon", "authenticated"]) {
            assert.equal((await db.query(`SELECT has_function_privilege('${role}', 'public.${fn}', 'EXECUTE') AS ok`)).rows[0].ok, false, `${role} ${fn}`);
        }
        assert.equal((await db.query(`SELECT has_function_privilege('service_role', 'public.${fn}', 'EXECUTE') AS ok`)).rows[0].ok, true, fn);
    }
});

test("the read-only overpaid query lists suman-like plans, and not after the duplicate is voided", async () => {
    const sql = fs.readFileSync(new URL("../scripts/find-overpaid-payments.sql", import.meta.url), "utf8");
    const [overpaidQuery, unlinkedQuery] = sql.split(/;\s*\n/).map((part) => part.trim()).filter((part) => /SELECT/.test(part));
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, "the query changes nothing");
    const m = await member(gymA, { paid: 1000 });
    await db.exec("ALTER TABLE public.payments DISABLE TRIGGER payments_within_balance");
    await db.query("INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method, paid_on) VALUES ($1, $2, $3, 1000, 'cash', $4)", [gymA, m.id, m.mm, today]);
    await db.query("INSERT INTO public.payments (gym_id, member_id, amount, method, paid_on) VALUES ($1, $2, 300, 'cash', $3)", [gymA, m.id, today]);
    await db.exec("ALTER TABLE public.payments ENABLE TRIGGER payments_within_balance");
    const name = (await db.query("SELECT full_name FROM public.members WHERE id = $1", [m.id])).rows[0].full_name;
    const listed = (await db.query(overpaidQuery)).rows.filter((row) => row.member === name);
    assert.equal(listed.length, 1);
    assert.equal(Number(listed[0].paid_too_much), 1000);
    assert.equal(listed[0].payments.split("\n").length, 2);
    assert.match(listed[0].payments, /saved \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2}/);
    assert.equal((await db.query(unlinkedQuery)).rows.filter((row) => row.member === name).length, 1);
    const duplicate = (await paymentsOf(m)).filter((row) => row.amount === 1000).at(-1);
    await voidIt(duplicate.id);
    assert.equal((await db.query(overpaidQuery)).rows.filter((row) => row.member === name).length, 0);
});
