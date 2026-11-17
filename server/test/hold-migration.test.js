// Runs migration 021 in real Postgres (PGlite): hold limits by plan length, starting rules, the
// remaining-days arithmetic, the four ways a hold ends, booked plans moving, cancel and refund,
// double taps, gym isolation and who may call the functions.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createMigratedDatabase } from "./helpers/database.js";

const owner = "00000000-0000-4000-8000-00000000000a";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
let db;
let today;
let monthly;
let quarterly;
let sixMonth;
let yearly;
let phones = 0;
let keys = 0;
const key = () => `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`;
const shift = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const day = (value) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);

const addPlan = async (gym, name, days, extra = {}) => (await db.query(
    "INSERT INTO public.membership_plans (gym_id, name, duration_days, price, max_hold_days, max_holds) VALUES ($1, $2, $3, 1000, $4, $5) RETURNING id",
    [gym, name, days, extra.maxDays ?? null, extra.maxHolds ?? null])).rows[0].id;
// A member whose plan started `startOffset` days from today and ends `endOffset` days from today.
const member = async (gym, planId, startOffset, endOffset) => {
    phones += 1;
    const phone = `98765${String(phones).padStart(5, "0")}`;
    await db.query("SELECT public.gympulse_import_members($1, $2::jsonb)", [gym, JSON.stringify({ rows: [{
        row: 2, full_name: `M ${phones}`, phone, notes: null, plan: { id: planId }, start_date: shift(today, startOffset), end_date: shift(today, endOffset), amount_paid: null }] })]);
    return (await db.query("SELECT id FROM public.members WHERE gym_id = $1 AND phone = $2", [gym, phone])).rows[0].id;
};
const startHold = (gym, memberId, startsOn, returnOn, options = {}) => db.query(
    "SELECT public.gympulse_start_hold($1, $2, $3, $4, $5, $6, $7, $8) AS r",
    [gym, memberId, options.key || key(), startsOn, returnOn, "method" in options ? options.method : "cash", options.utr ?? null, owner]).then((result) => result.rows[0].r);
const resume = (gym, holdId, reason = "resumed") => db.query("SELECT public.gympulse_resume_hold($1, $2, $3, $4) AS r", [gym, holdId, reason, owner]).then((result) => result.rows[0].r);
const cancel = (gym, holdId) => db.query("SELECT public.gympulse_cancel_hold($1, $2, $3) AS r", [gym, holdId, owner]).then((result) => result.rows[0].r);
const planRows = async (memberId) => (await db.query("SELECT start_date, end_date FROM public.member_memberships WHERE member_id = $1 ORDER BY start_date", [memberId])).rows
    .map((row) => ({ start: day(row.start_date), end: day(row.end_date) }));
// Pretend the hold began `days` days ago (the functions only know today's date).
const backdate = (holdId, days) => db.query(
    `UPDATE public.membership_holds SET starts_on = $2::date, latest_return_on = latest_return_on - $3::int,
        planned_return_on = CASE WHEN planned_return_on IS NULL THEN NULL ELSE planned_return_on - $3::int END,
        remaining_days = remaining_days + $3::int WHERE id = $1`, [holdId, shift(today, -days), days]);
const rejects = (promise, pattern) => assert.rejects(promise, pattern);

before(async () => {
    db = await createMigratedDatabase();
    today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).rows[0].d;
    await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${owner}', 'o@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'A', '${owner}'), ('${gymB}', 'B', '${owner}');`);
    monthly = await addPlan(gymA, "Monthly", 30);
    quarterly = await addPlan(gymA, "Quarterly", 90);
    sixMonth = await addPlan(gymA, "Six month", 180);
    yearly = await addPlan(gymA, "Yearly", 365);
});

// ---------- Limits and starting rules ----------

test("default limits by plan length, and a plan's own values win", async () => {
    const limits = (await db.query("SELECT d, (public.gympulse_hold_limits(null, null, d)).* FROM unnest(array[30, 31, 32, 90, 100, 101, 180, 190, 191, 365]) d")).rows
        .map((row) => [row.d, row.max_hold_days, row.max_holds]);
    assert.deepEqual(limits, [[30, 30, 0], [31, 30, 0], [32, 30, 1], [90, 30, 1], [100, 30, 1], [101, 30, 2], [180, 30, 2], [190, 30, 2], [191, 60, 2], [365, 60, 2]]);
    assert.deepEqual((await db.query("SELECT * FROM public.gympulse_hold_limits(10, 5, 30)")).rows[0], { max_hold_days: 10, max_holds: 5 });
    assert.deepEqual((await db.query("SELECT * FROM public.gympulse_hold_limits(null, 0, 365)")).rows[0], { max_hold_days: 60, max_holds: 0 });
});

test("a monthly plan can't be put on hold, with the reason", async () => {
    const id = await member(gymA, monthly, -10, 19);
    await rejects(startHold(gymA, id, today, null), /Monthly plans can't be put on hold/);
});

test("a plan's own limits can allow holds on a short plan", async () => {
    const custom = await addPlan(gymA, "Student", 30, { maxDays: 20, maxHolds: 1 });
    const id = await member(gymA, custom, -10, 19);
    await rejects(startHold(gymA, id, today, shift(today, 21)), /at most 20 days/);
    assert.ok((await startHold(gymA, id, today, shift(today, 20))).hold.id);
});

test("only a running plan (active or expiring) can be held: not grace, lapsed, old or upcoming", async () => {
    for (const [label, start, end] of [["in grace", -40, -2], ["lapsed", -120, -80], ["old", -400, -300], ["upcoming", 5, 94]]) {
        const id = await member(gymA, quarterly, start, end);
        await rejects(startHold(gymA, id, today, null), /running plan/, label);
    }
    const expiring = await member(gymA, quarterly, -85, 4);
    assert.ok((await startHold(gymA, expiring, today, null)).hold.id, "an expiring plan is allowed");
});

test("the hold must start between today and the plan's last day", async () => {
    const id = await member(gymA, quarterly, -20, 69);
    await rejects(startHold(gymA, id, shift(today, -1), null), /between today/);
    await rejects(startHold(gymA, id, shift(today, 70), null), /between today/);
    const later = await startHold(gymA, id, shift(today, 10), null);
    assert.equal(later.hold.remaining_days, 60, "remaining days count from the hold start");
});

test("the return date must be at least the gym's minimum and no more than the plan's maximum", async () => {
    const id = await member(gymA, quarterly, -20, 69);
    await rejects(startHold(gymA, id, today, shift(today, 14)), /at least 15 days/);
    await rejects(startHold(gymA, id, today, shift(today, 31)), /at most 30 days/);
    const ok = await startHold(gymA, id, today, shift(today, 15));
    assert.equal(day(ok.hold.planned_return_on), shift(today, 15));
    assert.equal(day(ok.hold.latest_return_on), shift(today, 30));
});

test("a minimum of 0 turns the minimum off (a return date still has to be after the start)", async () => {
    await db.query("UPDATE public.gyms SET min_hold_days = 0 WHERE id = $1", [gymA]);
    const id = await member(gymA, quarterly, -20, 69);
    await rejects(startHold(gymA, id, today, today), /at least 1 days/);
    assert.ok((await startHold(gymA, id, today, shift(today, 1))).hold.id);
    await db.query("UPDATE public.gyms SET min_hold_days = 15 WHERE id = $1", [gymA]);
});

test("holds left: one hold on a quarterly plan, two on a six-month plan", async () => {
    const q = await member(gymA, quarterly, -20, 69);
    const first = await startHold(gymA, q, today, null);
    await resume(gymA, first.hold.id);
    await rejects(startHold(gymA, q, today, null), /already used/);

    const six = await member(gymA, sixMonth, -20, 159);
    const one = await startHold(gymA, six, today, null);
    await resume(gymA, one.hold.id);
    const two = await startHold(gymA, six, today, null);
    await resume(gymA, two.hold.id);
    await rejects(startHold(gymA, six, today, null), /Both holds already used/);
});

test("a member can only have one open hold at a time", async () => {
    const id = await member(gymA, yearly, -20, 344);
    await startHold(gymA, id, today, null);
    await rejects(startHold(gymA, id, today, null), /already has a hold/);
});

// ---------- Remaining days and the new end date ----------

test("remaining days and the new end date: hold on 1 March, plan ends 31 March, back on 4 March -> 3 April", async () => {
    const id = await member(gymA, yearly, -20, 30); // ends today + 30 ("31 March")
    const hold = await startHold(gymA, id, today, null); // "1 March"
    assert.equal(hold.hold.remaining_days, 31);
    await backdate(hold.hold.id, 3); // back on "4 March"
    const done = await resume(gymA, hold.hold.id);
    assert.equal(done.hold.days_held, 3);
    assert.equal(day(done.hold.end_before), shift(today, 30));
    assert.equal(day(done.hold.end_after), shift(today, 33), "31 March + 3 days = 3 April");
    assert.equal(day(done.membership.end_date), shift(today, 33));
    assert.equal((await planRows(id))[0].end, shift(today, 33));
});

test("coming back early still counts as a hold and extends only by the days held", async () => {
    const id = await member(gymA, quarterly, -20, 69);
    const hold = await startHold(gymA, id, today, shift(today, 25));
    await backdate(hold.hold.id, 2);
    const done = await resume(gymA, hold.hold.id);
    assert.equal(done.hold.days_held, 2, "2 days, not the 25 planned");
    assert.equal(done.hold.end_reason, "resumed");
    assert.equal((await planRows(id))[0].end, shift(today, 71));
    await rejects(startHold(gymA, id, today, null), /already used/);
});

// ---------- The four ways a hold ends ----------

test("a hold ends on its planned return date (saved the next time the member is read)", async () => {
    const id = await member(gymA, sixMonth, -20, 159);
    const hold = await startHold(gymA, id, today, shift(today, 20));
    await backdate(hold.hold.id, 25); // began 25 days ago, planned return was 5 days ago
    assert.equal((await db.query("SELECT public.gympulse_settle_holds($1, $2) AS c", [gymA, id])).rows[0].c, 1);
    const row = (await db.query("SELECT * FROM public.membership_holds WHERE id = $1", [hold.hold.id])).rows[0];
    assert.equal(row.end_reason, "return_date");
    assert.equal(day(row.ended_on), shift(today, -5));
    assert.equal(row.days_held, 20);
    assert.equal((await planRows(id))[0].end, shift(today, 179));
    assert.equal((await db.query("SELECT public.gympulse_settle_holds($1, $2) AS c", [gymA, id])).rows[0].c, 0, "settling again changes nothing");
});

test("an open-ended hold ends when its maximum runs out", async () => {
    const id = await member(gymA, yearly, -20, 344);
    const hold = await startHold(gymA, id, today, null);
    await backdate(hold.hold.id, 70); // maximum was 60 days, so it ended 10 days ago
    await db.query("SELECT public.gympulse_settle_holds($1)", [gymA]);
    const row = (await db.query("SELECT * FROM public.membership_holds WHERE id = $1", [hold.hold.id])).rows[0];
    assert.equal(row.end_reason, "max_days");
    assert.equal(row.days_held, 60);
    assert.equal((await planRows(id))[0].end, shift(today, 404));
});

test("the member's first check-in ends it", async () => {
    const id = await member(gymA, yearly, -20, 344);
    const hold = await startHold(gymA, id, today, null);
    await backdate(hold.hold.id, 4);
    const done = await resume(gymA, hold.hold.id, "check_in");
    assert.equal(done.hold.end_reason, "check_in");
    assert.equal(done.hold.days_held, 4);
});

test("resume twice is a replay: nothing changes the second time", async () => {
    const id = await member(gymA, yearly, -20, 344);
    const hold = await startHold(gymA, id, today, null);
    await backdate(hold.hold.id, 3);
    await resume(gymA, hold.hold.id);
    const again = await resume(gymA, hold.hold.id, "check_in");
    assert.equal(again.replayed, true);
    assert.equal(again.hold.end_reason, "resumed", "the first reason stays");
    assert.equal((await planRows(id))[0].end, shift(today, 347));
});

test("a hold that hasn't started yet can only be cancelled, not resumed", async () => {
    const id = await member(gymA, yearly, -20, 344);
    const hold = await startHold(gymA, id, shift(today, 5), null);
    await rejects(resume(gymA, hold.hold.id), /not started yet/);
    assert.equal((await cancel(gymA, hold.hold.id)).hold.cancelled, true);
});

// ---------- Booked plans ----------

test("a plan already booked moves later by the days held", async () => {
    const id = await member(gymA, yearly, -20, 344);
    await db.query("INSERT INTO public.member_memberships (gym_id, member_id, plan_id, plan_name, duration_days, price, total_fees, start_date, end_date) VALUES ($1, $2, $3, 'Yearly', 365, 1000, 1000, $4, $5)",
        [gymA, id, yearly, shift(today, 345), shift(today, 709)]);
    const hold = await startHold(gymA, id, today, null);
    await backdate(hold.hold.id, 6);
    const done = await resume(gymA, hold.hold.id);
    assert.deepEqual(await planRows(id), [{ start: shift(today, -20), end: shift(today, 350) }, { start: shift(today, 351), end: shift(today, 715) }]);
    assert.equal(done.moved_plans.length, 1);
});

test("while a hold is running, renewing, assigning a plan and importing are refused", async () => {
    const id = await member(gymA, yearly, -20, 344);
    await startHold(gymA, id, today, null);
    await rejects(db.query("SELECT public.gympulse_renew_member($1, $2, $3, $4, null, null, null, null, 0, 'cash', null, $5)", [gymA, id, key(), yearly, owner]), /Resume the plan first/);
    await rejects(db.query("INSERT INTO public.member_memberships (gym_id, member_id, plan_id, plan_name, duration_days, price, total_fees, start_date, end_date) VALUES ($1, $2, $3, 'Yearly', 365, 1000, 1000, $4, $5)",
        [gymA, id, yearly, shift(today, 400), shift(today, 764)]), /Resume the plan first/);
});

// ---------- Cancel ----------

test("cancel on the day it starts undoes everything and gives the hold back", async () => {
    const id = await member(gymA, quarterly, -20, 69);
    const hold = await startHold(gymA, id, today, null);
    const result = await cancel(gymA, hold.hold.id);
    assert.equal(result.hold.cancelled, true);
    assert.equal((await planRows(id))[0].end, shift(today, 69), "the plan is untouched");
    assert.ok((await startHold(gymA, id, today, null)).hold.id, "the hold does not count as used");
    assert.equal((await cancel(gymA, hold.hold.id)).replayed, true, "cancelling twice is harmless");
});

test("cancel is refused once the hold has begun (a day later): resume it instead", async () => {
    const id = await member(gymA, yearly, -20, 344);
    const hold = await startHold(gymA, id, today, null);
    await backdate(hold.hold.id, 1);
    await rejects(cancel(gymA, hold.hold.id), /only be cancelled on the day/);
});

// ---------- Hold fee ----------

test("a hold fee is recorded as a payment, kept out of the plan balance, and refunded on cancel", async () => {
    await db.query("UPDATE public.gyms SET hold_fee_enabled = true, hold_fee_amount = 200 WHERE id = $1", [gymA]);
    try {
        const id = await member(gymA, yearly, -20, 344);
        await rejects(startHold(gymA, id, today, null, { method: null }), /Choose how the hold fee was paid/);
        const hold = await startHold(gymA, id, today, null, { method: "upi", utr: "123456789012" });
        assert.equal(hold.payment.kind, "hold_fee");
        assert.equal(Number(hold.payment.amount), 200);
        assert.equal(Number(hold.hold.fee_amount), 200);
        assert.ok(hold.payment.receipt_number);
        assert.equal(Number((await db.query("SELECT outstanding FROM public.member_balances WHERE member_id = $1", [id])).rows[0].outstanding), 1000, "the plan's fee is still all due");
        const collected = async () => Number((await db.query("SELECT public.gympulse_gym_summary($1) AS s", [gymA])).rows[0].s.collected_all_time);
        const before = await collected();
        await cancel(gymA, hold.hold.id);
        const paid = (await db.query("SELECT refunded_at, receipt_number FROM public.payments WHERE id = $1", [hold.payment.id])).rows[0];
        assert.ok(paid.refunded_at && paid.receipt_number, "the payment stays, marked refunded");
        assert.equal(before - await collected(), 200, "a refund leaves the collected totals");
    } finally {
        await db.query("UPDATE public.gyms SET hold_fee_enabled = false, hold_fee_amount = 0 WHERE id = $1", [gymA]);
    }
});

test("only a hold fee can be marked refunded", async () => {
    const id = await member(gymA, monthly, -5, 24);
    const payment = (await db.query("INSERT INTO public.payments (gym_id, member_id, membership_id, amount, method) VALUES ($1, $2, (SELECT id FROM public.member_memberships WHERE member_id = $2 LIMIT 1), 500, 'cash') RETURNING id", [gymA, id])).rows[0].id;
    await rejects(db.query("UPDATE public.payments SET refunded_at = now() WHERE id = $1", [payment]), /payments_refund_valid/);
});

// ---------- Double taps, isolation, access ----------

test("the same key twice (a double tap) creates exactly one hold and one fee", async () => {
    await db.query("UPDATE public.gyms SET hold_fee_enabled = true, hold_fee_amount = 100 WHERE id = $1", [gymA]);
    try {
        const id = await member(gymA, yearly, -20, 344);
        const sameKey = key();
        const [a, b] = await Promise.all([startHold(gymA, id, today, null, { key: sameKey }), startHold(gymA, id, today, null, { key: sameKey })]);
        assert.equal(a.hold.id, b.hold.id);
        assert.equal((await db.query("SELECT count(*)::int AS c FROM public.membership_holds WHERE member_id = $1", [id])).rows[0].c, 1);
        assert.equal((await db.query("SELECT count(*)::int AS c FROM public.payments WHERE member_id = $1 AND kind = 'hold_fee'", [id])).rows[0].c, 1);
    } finally {
        await db.query("UPDATE public.gyms SET hold_fee_enabled = false, hold_fee_amount = 0 WHERE id = $1", [gymA]);
    }
});

test("a request key can't be reused for another member", async () => {
    const one = await member(gymA, yearly, -20, 344);
    const two = await member(gymA, yearly, -20, 344);
    const sameKey = key();
    await startHold(gymA, one, today, null, { key: sameKey });
    await rejects(startHold(gymA, two, today, null, { key: sameKey }), /belongs to another member/);
});

test("another gym's member can't be held, resumed or cancelled", async () => {
    const id = await member(gymA, yearly, -20, 344);
    const hold = await startHold(gymA, id, today, null);
    await rejects(startHold(gymB, id, today, null), /Member not found/);
    await rejects(resume(gymB, hold.hold.id), /Hold not found/);
    await rejects(cancel(gymB, hold.hold.id), /Hold not found/);
});

test("a failed start leaves nothing behind (no hold, no fee)", async () => {
    await db.query("UPDATE public.gyms SET hold_fee_enabled = true, hold_fee_amount = 100 WHERE id = $1", [gymA]);
    try {
        const id = await member(gymA, yearly, -20, 344);
        await rejects(startHold(gymA, id, today, shift(today, 5)), /at least 15 days/);
        assert.equal((await db.query("SELECT count(*)::int AS c FROM public.payments WHERE member_id = $1 AND kind = 'hold_fee'", [id])).rows[0].c, 0);
    } finally {
        await db.query("UPDATE public.gyms SET hold_fee_enabled = false, hold_fee_amount = 0 WHERE id = $1", [gymA]);
    }
});

test("hold functions are for the server only, and holds are readable only inside their own gym", async () => {
    const privilege = async (role, signature) => (await db.query("SELECT has_function_privilege($1, $2, 'execute') AS ok", [role, signature])).rows[0].ok;
    for (const signature of [
        "public.gympulse_start_hold(uuid, uuid, uuid, date, date, text, text, uuid)", "public.gympulse_resume_hold(uuid, uuid, text, uuid)",
        "public.gympulse_cancel_hold(uuid, uuid, uuid)", "public.gympulse_settle_holds(uuid, uuid)"
    ]) {
        assert.equal(await privilege("service_role", signature), true, signature);
        assert.equal(await privilege("authenticated", signature), false, signature);
        assert.equal(await privilege("anon", signature), false, signature);
    }
    assert.equal((await db.query("SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'membership_holds'")).rows[0].rls, true);
    assert.equal((await db.query("SELECT has_table_privilege('authenticated', 'public.membership_holds', 'insert') AS w")).rows[0].w, false);
});

test("running migration 021 again changes nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../migrations/021_add_plan_holds.sql", import.meta.url), "utf8");
    const before = (await db.query("SELECT count(*)::int AS c FROM public.membership_holds")).rows[0].c;
    await db.exec(sql);
    assert.equal((await db.query("SELECT count(*)::int AS c FROM public.membership_holds")).rows[0].c, before);
});
