// Runs migration 016 in real Postgres (PGlite): a member import is saved whole or not at all,
// stays inside one gym, and never gives imported members WhatsApp or photo consent.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createMigratedDatabase } from "./helpers/database.js";

const ownerA = "00000000-0000-4000-8000-00000000000a";
const ownerB = "00000000-0000-4000-8000-00000000000b";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
let db;
let today;
let monthly;
let otherGymPlan;
let codes = 0;

const run = (gymId, payload) => db.query("SELECT public.gympulse_import_members($1, $2::jsonb) AS result", [gymId, JSON.stringify(payload)]).then((r) => r.rows[0].result);
const count = async (table, gymId = gymA) => (await db.query(`SELECT count(*)::int AS n FROM public.${table} WHERE gym_id = $1`, [gymId])).rows[0].n;
const member = async (phone, gymId = gymA) => (await db.query("SELECT * FROM public.members WHERE gym_id = $1 AND phone = $2", [gymId, phone])).rows[0];
const isoDate = (value) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
const shift = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const row = (number, name, phone, extra = {}) => ({ row: number, full_name: name, phone, notes: null, plan: null, start_date: null, end_date: null, amount_paid: null, ...extra });

async function snapshot(gymId = gymA) {
    return Promise.all(["members", "membership_plans", "member_memberships", "payments"].map((table) => count(table, gymId)));
}

before(async () => {
    db = await createMigratedDatabase();
    today = isoDate((await db.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d")).rows[0].d);
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${ownerA}', 'a@example.test'), ('${ownerB}', 'b@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'Gym A', '${ownerA}'), ('${gymB}', 'Gym B', '${ownerB}');
        INSERT INTO public.gym_users (gym_id, user_id) VALUES ('${gymA}', '${ownerA}'), ('${gymB}', '${ownerB}');
    `);
    monthly = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 1000) RETURNING id", [gymA])).rows[0].id;
    otherGymPlan = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 900) RETURNING id", [gymB])).rows[0].id;
});

test("members, their plans with the file's dates, and amounts paid are saved together", async () => {
    const start = shift(today, -10);
    const result = await run(gymA, {
        update_existing: false,
        new_plans: [{ ref: "new-1", name: "Gold Quarterly", duration_days: 90, price: 2500 }],
        rows: [
            row(2, "Riya Shah", "9876500001", { plan: { id: monthly }, start_date: start, end_date: shift(start, 44), amount_paid: 600, notes: "Paid half in cash" }),
            row(3, "Dev Rao", "9876500002", { plan: { id: monthly }, start_date: start }),
            row(4, "Aisha Khan", "9876500003", { plan: { ref: "new-1" }, end_date: shift(today, 20), amount_paid: 2500 }),
            row(5, "Kabir Mehta", "9876500004")
        ]
    });
    assert.deepEqual(result, { created: 4, updated: 0, memberships: 3, payments: 2, plans_created: 1 });

    const riya = await member("9876500001");
    assert.equal(riya.notes, "Paid half in cash");
    assert.equal(riya.whatsapp_opt_in, false, "imported members never get WhatsApp consent");
    assert.equal(riya.photo_consent, false, "imported members never get photo consent");
    // Migration 022: a new member gets the gym's next short code (GP-101, GP-102, …).
    assert.match(riya.member_code, /^GP-\d{3,}$/);
    const riyaPlan = (await db.query("SELECT * FROM public.member_memberships WHERE member_id = $1", [riya.id])).rows[0];
    assert.equal(isoDate(riyaPlan.end_date), shift(start, 44), "the end date from the file is kept");
    assert.equal(riyaPlan.duration_days, 45);
    assert.equal(Number(riyaPlan.total_fees), 1000, "the fee is the plan's price");
    assert.equal(isoDate(riya.membership_end_date), shift(start, 44), "the older date columns follow the current plan");
    const riyaPayment = (await db.query("SELECT * FROM public.payments WHERE member_id = $1", [riya.id])).rows[0];
    assert.equal(Number(riyaPayment.amount), 600);
    assert.equal(riyaPayment.method, "other");
    assert.equal(isoDate(riyaPayment.paid_on), start);
    assert.match(riyaPayment.receipt_number, /^R-\d{6}$/);

    const dev = await member("9876500002");
    const devPlan = (await db.query("SELECT * FROM public.member_memberships WHERE member_id = $1", [dev.id])).rows[0];
    assert.equal(isoDate(devPlan.end_date), shift(start, 29), "a start date alone uses the plan's length");
    const aisha = await member("9876500003");
    const aishaPlan = (await db.query("SELECT * FROM public.member_memberships WHERE member_id = $1", [aisha.id])).rows[0];
    assert.equal(aishaPlan.plan_name, "Gold Quarterly");
    assert.equal(isoDate(aishaPlan.start_date), shift(today, 20 - 89), "an end date alone counts back the plan's length");
    const aishaPayment = (await db.query("SELECT paid_on FROM public.payments WHERE member_id = $1", [aisha.id])).rows[0];
    assert.equal(isoDate(aishaPayment.paid_on), shift(today, 20 - 89));
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.member_memberships WHERE member_id = (SELECT id FROM public.members WHERE phone = '9876500004')")).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.member_consent_events WHERE gym_id = $1", [gymA])).rows[0].n, 0, "no consent history is written");
});

test("if any row fails, nothing is saved: no members, plans, memberships or payments", async () => {
    const before = await snapshot();
    for (const [payload, message] of [
        [{ new_plans: [{ ref: "new-1", name: "Silver", duration_days: 30, price: 700 }], rows: [row(2, "New Person", "9876500101", { plan: { ref: "new-1" }, start_date: today, amount_paid: 700 }), row(3, "Riya Again", "9876500001")] }, /Row 3: Riya Shah already has this phone number/],
        [{ rows: [row(2, "Two Rows", "9876500102"), row(9, "Same Phone", "9876500102")] }, /Row 9: this phone number is on another row/],
        [{ rows: [row(2, "Other Gym Plan", "9876500103", { plan: { id: otherGymPlan }, start_date: today })] }, /Row 2: the plan is not one of this gym's plans/],
        [{ rows: [row(4, "Paid No Plan", "9876500104", { amount_paid: 500 })] }, /Row 4: an amount paid needs a plan/],
        [{ rows: [row(5, "No Dates", "9876500105", { plan: { id: monthly } })] }, /Row 5: the plan needs a start date or an end date/],
        [{ rows: [row(6, "Backwards", "9876500106", { plan: { id: monthly }, start_date: today, end_date: shift(today, -1) })] }, /Row 6: the end date is before the start date/],
        [{ rows: [row(7, "Bad Phone", "12345")] }, /Row 7: the phone number is not a 10-digit/],
        [{ new_plans: [{ ref: "new-1", name: " monthly ", duration_days: 30, price: 1 }], rows: [row(2, "Clash", "9876500107")] }, /A plan called "monthly" already exists/],
        [{ rows: [] }, /no members to import/]
    ]) {
        await assert.rejects(run(gymA, { update_existing: false, ...payload }), message);
    }
    assert.deepEqual(await snapshot(), before);
});

test("updating existing members changes their name and notes and adds the file's plan", async () => {
    const riya = await member("9876500001");
    const kabir = await member("9876500004");
    const result = await run(gymA, {
        update_existing: true,
        rows: [
            row(2, "Kabir S Mehta", "+91 98765 00004".replace(/\D/g, "").slice(-10), { notes: "Morning batch", plan: { id: monthly }, start_date: today, amount_paid: 1000 }),
            row(3, "Brand New", "9876500201")
        ]
    });
    assert.deepEqual(result, { created: 1, updated: 1, memberships: 1, payments: 1, plans_created: 0 });
    const updated = await member("9876500004");
    assert.equal(updated.id, kabir.id);
    assert.equal(updated.full_name, "Kabir S Mehta");
    assert.equal(updated.notes, "Morning batch");
    // A plan that overlaps one the member already has stops the whole import.
    const before = await snapshot();
    await assert.rejects(run(gymA, { update_existing: true, rows: [row(8, "Riya Shah", "9876500001", { plan: { id: monthly }, start_date: today })] }), /Row 8: Riya Shah already has a plan during those dates/);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await member("9876500001")).notes, riya.notes);
});

test("a turned-off plan cannot be used, and phones of archived members can be imported again", async () => {
    const old = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price, is_active) VALUES ($1, 'Old Plan', 30, 500, false) RETURNING id", [gymA])).rows[0].id;
    await assert.rejects(run(gymA, { rows: [row(2, "Old Plan User", "9876500301", { plan: { id: old }, start_date: today })] }), /turned off/);
    await db.query("INSERT INTO public.members (gym_id, member_code, full_name, phone, archived_at) VALUES ($1, $2, 'Left Gym', '9876500302', now())", [gymA, `GP-OLD${++codes}`]);
    const result = await run(gymA, { rows: [row(2, "Back Again", "9876500302")] });
    assert.equal(result.created, 1);
});

test("the import stays inside its gym and only the backend can run it", async () => {
    const before = await snapshot(gymB);
    await run(gymB, { rows: [row(2, "Gym B Member", "9876500001", { plan: { id: otherGymPlan }, start_date: today })] });
    const [membersB] = await snapshot(gymB);
    assert.equal(membersB, before[0] + 1, "the same phone in another gym is a different member");
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${ownerA}', false);`);
    try {
        await assert.rejects(run(gymA, { rows: [row(2, "Sneaky", "9876500401")] }), /permission denied/);
    } finally {
        await db.exec("RESET ROLE;");
    }
});
