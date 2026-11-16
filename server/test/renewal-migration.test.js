// Runs on a database at migration 019: migration 021 later removes this renewal function (020 replaced it).
// Runs migration 019 in real Postgres (PGlite): one-tap renewal creates the plan, the payment and
// the renewal record in one transaction, works out the start date itself, never renews twice for
// the same key, refuses overlapping plans, and stays inside one gym. Also checks that the Overview
// totals skip a renewed member, and that the shared JS start-date rules agree with the SQL.
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
let retired;
let otherGymPlan;
let phoneCount = 0;
let keyCount = 0;

const shift = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const day = (value) => String(value).slice(0, 10);
const uuid = () => `00000000-0000-4000-8000-${String(++keyCount).padStart(12, "0")}`;
const count = async (table, gymId) => (await db.query(`SELECT count(*)::int AS n FROM public.${table} WHERE gym_id = $1`, [gymId])).rows[0].n;
const plan = async (gymId, name, days, price, active = true) => (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id", [gymId, name, days, price, active])).rows[0].id;

/** A member whose current plan started startOffset and ends endOffset days from today (no plan: nulls). */
async function member(gymId, startOffset, endOffset, planId, { paid = 1500 } = {}) {
    phoneCount += 1;
    const phone = `98765${String(phoneCount).padStart(5, "0")}`;
    await db.query("SELECT public.gympulse_import_members($1, $2::jsonb)", [gymId, JSON.stringify({
        rows: [{ row: 2, full_name: `Member ${phoneCount}`, phone, notes: null, plan: planId ? { id: planId } : null,
            start_date: planId ? shift(today, startOffset) : null, end_date: planId ? shift(today, endOffset) : null, amount_paid: planId ? paid : null }]
    })]);
    return (await db.query("SELECT id FROM public.members WHERE gym_id = $1 AND phone = $2", [gymId, phone])).rows[0].id;
}

const renew = (gymId, memberId, args = {}) => db.query("SELECT public.gympulse_renew_member($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS r", [
    gymId, memberId, args.key || uuid(), args.plan || monthly, args.backdate || false, args.expected || null,
    args.fee ?? null, args.paid ?? null, args.method || "cash", args.utr || null, owner
]).then((result) => result.rows[0].r);
const failure = async (promise) => promise.then(() => null, (error) => error);

before(async () => {
    db = await createMigratedDatabase({ upTo: "019_add_one_tap_renewal.sql" });
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${owner}', 'owner@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'Gym A', '${owner}'), ('${gymB}', 'Gym B', '${owner}');
        INSERT INTO public.gym_users (gym_id, user_id) VALUES ('${gymA}', '${owner}');
    `);
    today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).rows[0].d;
    monthly = await plan(gymA, "Monthly", 30, 1500);
    quarterly = await plan(gymA, "Quarterly", 90, 4000);
    retired = await plan(gymA, "Retired", 30, 900, false);
    otherGymPlan = await plan(gymB, "Monthly", 30, 1500);
});

// ---------- Start dates ----------

test("a plan that is expiring starts the day after it ends: no days lost, no overlap", async () => {
    const id = await member(gymA, -26, 3, monthly);
    const result = await renew(gymA, id, { paid: 1500 });
    assert.equal(day(result.membership.start_date), shift(today, 4));
    assert.equal(day(result.membership.end_date), shift(today, 33), "start + 30 days - 1");
    assert.equal(result.renewal.start_choice, "after_current");
});

test("a plan that is active with time left also starts the day after it ends", async () => {
    const id = await member(gymA, -10, 19, monthly);
    const result = await renew(gymA, id, { backdate: true, paid: 0 });
    assert.equal(day(result.membership.start_date), shift(today, 20));
    assert.equal(result.renewal.start_choice, "after_current", "the backdate option does not apply while the plan is active");
});

test("an expired member starts today by default", async () => {
    const id = await member(gymA, -50, -20, monthly);
    const result = await renew(gymA, id, { paid: 1500 });
    assert.equal(day(result.membership.start_date), today);
    assert.equal(result.renewal.start_choice, "today");
});

test("the backdate option starts the day after the old plan ended", async () => {
    const id = await member(gymA, -50, -20, monthly);
    const result = await renew(gymA, id, { backdate: true, paid: 1500 });
    assert.equal(day(result.membership.start_date), shift(today, -19));
    assert.equal(result.renewal.start_choice, "after_old_plan");
});

test("a member with no plan yet starts today", async () => {
    const id = await member(gymA, 0, 0, null);
    const result = await renew(gymA, id, { paid: 1500 });
    assert.equal(day(result.membership.start_date), today);
});

test("a plan already queued to start later is refused instead of overlapping", async () => {
    const id = await member(gymA, -20, 9, monthly);
    await renew(gymA, id, { paid: 1500 });
    const error = await failure(renew(gymA, id, { paid: 1500 }));
    assert.match(error.message, /already has a plan starting on/);
    assert.equal(error.code, "P0001");
    assert.match(error.detail, /future_plan/);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.member_memberships WHERE member_id = $1", [id])).rows[0].n, 2);
});

test("the start date the screen showed is checked: a different one is refused, the same is accepted", async () => {
    const id = await member(gymA, -20, 9, monthly);
    const wrong = await failure(renew(gymA, id, { expected: today }));
    assert.match(wrong.message, /dates changed/);
    assert.match(wrong.detail, /dates_changed/);
    const result = await renew(gymA, id, { expected: shift(today, 10), paid: 1500 });
    assert.equal(day(result.membership.start_date), shift(today, 10));
});

// The shared JS start-date rules are checked against the current renew function (migration 020)
// in member-status.test.js.

// ---------- Plan, price and payment ----------

test("a different plan and an edited price (a discount) are used, and the list price is kept", async () => {
    const id = await member(gymA, -20, 9, monthly);
    const result = await renew(gymA, id, { plan: quarterly, fee: 3500, paid: 3500 });
    assert.equal(result.membership.plan_name, "Quarterly");
    assert.equal(Number(result.membership.total_fees), 3500, "what is charged");
    assert.equal(Number(result.membership.price), 4000, "the plan's own price");
    assert.equal(Number(result.renewal.plan_price), 4000);
    assert.equal(day(result.membership.end_date), shift(today, 10 + 89));
});

test("a partial payment leaves the balance: this renewal's share and the member's whole balance", async () => {
    const id = await member(gymA, -20, 9, monthly, { paid: 1000 }); // the older plan has 500 unpaid
    const result = await renew(gymA, id, { fee: 1500, paid: 600, method: "upi", utr: "210000000001" });
    assert.equal(Number(result.payment.amount), 600);
    assert.equal(Number(result.renewal.fee) - Number(result.renewal.amount_paid), 900, "left on this renewal");
    assert.equal(result.balance.outstanding, 1400, "900 on this renewal + 500 from the older plan");
    assert.match(result.payment.receipt_number, /^R-\d{6}$/);
});

test("paying nothing renews without a payment record", async () => {
    const id = await member(gymA, -20, 9, monthly);
    const before = await count("payments", gymA);
    const result = await renew(gymA, id, { paid: 0 });
    assert.equal(result.payment, null);
    assert.equal(await count("payments", gymA), before);
    assert.equal(result.balance.outstanding, 1500);
});

test("the amount paid cannot be more than the fee, a fee cannot be negative, and the plan must be active", async () => {
    const id = await member(gymA, -20, 9, monthly);
    assert.match((await failure(renew(gymA, id, { fee: 1000, paid: 1500 }))).message, /between zero and the fee/);
    assert.match((await failure(renew(gymA, id, { fee: -1 }))).message, /cannot be negative/);
    assert.match((await failure(renew(gymA, id, { plan: retired }))).message, /active plans/);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.member_memberships WHERE member_id = $1", [id])).rows[0].n, 1, "nothing was created");
});

// ---------- One transaction, one renewal ----------

test("if the payment fails, the plan and the renewal record are not saved either", async () => {
    const first = await member(gymA, -20, 9, monthly);
    await renew(gymA, first, { paid: 500, method: "upi", utr: "220000000002" });
    const second = await member(gymA, -20, 9, monthly);
    const before = [await count("member_memberships", gymA), await count("payments", gymA), await count("membership_renewals", gymA)];
    const error = await failure(renew(gymA, second, { paid: 500, method: "upi", utr: "220000000002" }));
    assert.equal(error.code, "23505", "the UTR is already used");
    assert.deepEqual([await count("member_memberships", gymA), await count("payments", gymA), await count("membership_renewals", gymA)], before);
    assert.equal((await db.query("SELECT membership_end_date::text AS d FROM public.members WHERE id = $1", [second])).rows[0].d, shift(today, 9), "the member's dates are untouched");
});

test("the same key twice (a double tap or a retry) creates exactly one renewal and returns the first result", async () => {
    const id = await member(gymA, -20, 9, monthly);
    const key = uuid();
    const first = await renew(gymA, id, { key, paid: 1500 });
    const again = await renew(gymA, id, { key, paid: 1500 });
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.equal(again.membership.id, first.membership.id);
    assert.equal(again.payment.id, first.payment.id);
    const rows = (await db.query(`SELECT (SELECT count(*) FROM public.member_memberships WHERE member_id = $1)::int AS plans,
        (SELECT count(*) FROM public.payments WHERE member_id = $1 AND note = 'Renewal')::int AS payments,
        (SELECT count(*) FROM public.membership_renewals WHERE member_id = $1)::int AS renewals`, [id])).rows[0];
    assert.deepEqual(rows, { plans: 2, payments: 1, renewals: 1 });
});

// PGlite runs both calls one after the other; on Postgres the member row lock (FOR UPDATE) and
// the unique key make the second wait and then return the first answer.
test("two requests sent together with the same key still renew once", async () => {
    const id = await member(gymA, -20, 9, monthly);
    const key = uuid();
    const results = await Promise.all([renew(gymA, id, { key, paid: 1500 }), renew(gymA, id, { key, paid: 1500 })]);
    assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.membership_renewals WHERE member_id = $1", [id])).rows[0].n, 1);
});

test("a key cannot be reused for another member", async () => {
    const one = await member(gymA, -20, 9, monthly);
    const two = await member(gymA, -20, 9, monthly);
    const key = uuid();
    await renew(gymA, one, { key, paid: 0 });
    assert.match((await failure(renew(gymA, two, { key, paid: 0 }))).message, /another member/);
});

// ---------- Gyms and access ----------

test("another gym's member or plan cannot be used", async () => {
    const foreign = await member(gymB, -20, 9, otherGymPlan);
    assert.match((await failure(renew(gymA, foreign))).message, /Member not found/);
    const mine = await member(gymA, -20, 9, monthly);
    assert.match((await failure(renew(gymA, mine, { plan: otherGymPlan }))).message, /Plan not found/);
    assert.equal(await count("membership_renewals", gymB), 0);
});

test("only the server (service role) can renew, and the record is readable only inside its own gym", async () => {
    const id = await member(gymA, -20, 9, monthly);
    await db.exec("SET ROLE authenticated");
    try {
        assert.match((await failure(renew(gymA, id))).message, /permission denied/);
        await db.exec(`SET request.jwt.claim.sub = '${owner}'`);
        assert.ok((await db.query("SELECT count(*)::int AS n FROM public.membership_renewals")).rows[0].n > 0, "an owner reads their own gym's renewals");
        assert.equal((await db.query("SELECT count(*)::int AS n FROM public.membership_renewals WHERE gym_id = $1", [gymB])).rows[0].n, 0);
        assert.match((await failure(db.query("DELETE FROM public.membership_renewals"))).message, /permission denied/);
    } finally {
        await db.exec("RESET ROLE");
    }
});

test("each renewal is recorded with who made it, and gym deletion still works with renewals present", async () => {
    assert.ok((await db.query("SELECT count(*)::int AS n FROM public.membership_renewals WHERE recorded_by = $1", [owner])).rows[0].n > 5);
    await db.query("UPDATE public.gyms SET deletion_requested_at = now() - interval '8 days', deletion_scheduled_for = now() - interval '1 day', deletion_requested_by = $2 WHERE id = $1", [gymB, owner]);
    await db.exec("SET ROLE service_role");
    try {
        await db.query("SELECT public.gympulse_delete_gym($1)", [gymB]);
    } finally {
        await db.exec("RESET ROLE");
    }
    assert.equal(await count("membership_renewals", gymB), 0);
});

test("the migration can be run again", async () => {
    const { readFileSync } = await import("node:fs");
    await db.exec(readFileSync(new URL("../migrations/019_add_one_tap_renewal.sql", import.meta.url), "utf8"));
});

// ---------- Overview totals ----------

test("a renewed member leaves the Overview's expiring counts; every other total is unchanged", async () => {
    const summaryDb = await createMigratedDatabase({ upTo: "019_add_one_tap_renewal.sql" });
    const gym = "00000000-0000-4000-8000-0000000000c1";
    await summaryDb.exec(`INSERT INTO auth.users (id, email) VALUES ('${owner}', 'o@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gym}', 'Gym C', '${owner}');`);
    const planId = (await summaryDb.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 1500) RETURNING id", [gym])).rows[0].id;
    const add = async (n, endOffset) => {
        await summaryDb.query("SELECT public.gympulse_import_members($1, $2::jsonb)", [gym, JSON.stringify({ rows: [{ row: 2, full_name: `Summary ${n}`, phone: `9876${String(n).padStart(6, "0")}`, notes: null, plan: { id: planId }, start_date: shift(today, endOffset - 29), end_date: shift(today, endOffset), amount_paid: 1500 }] })]);
        return (await summaryDb.query("SELECT id FROM public.members WHERE gym_id = $1 AND phone = $2", [gym, `9876${String(n).padStart(6, "0")}`])).rows[0].id;
    };
    const soon = await add(1, 3);
    await add(2, 3);
    await add(3, 20);
    const summary = async () => (await summaryDb.query("SELECT public.gympulse_gym_summary($1, 6) AS s", [gym])).rows[0].s;
    const before = await summary();
    assert.equal(before.expiring_in_7_days, 2);
    assert.equal(before.expiring_in_30_days, 3);

    await summaryDb.query("SELECT public.gympulse_renew_member($1, $2, $3, $4, false, null, null, 1500, 'cash', null, $5)", [gym, soon, uuid(), planId, owner]);
    const after = await summary();
    assert.equal(after.expiring_in_7_days, 1, "the renewed member is no longer expiring");
    assert.equal(after.expiring_in_30_days, 2);
    for (const field of ["total_members", "active_members", "new_members_this_month", "members_with_balance", "inactive_members"]) {
        assert.equal(after[field], before[field], field);
    }
    assert.equal(after.renewals_this_month, before.renewals_this_month + 1);
    assert.equal(Number(after.collected_all_time), Number(before.collected_all_time) + 1500);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "the same figures as before");
});
