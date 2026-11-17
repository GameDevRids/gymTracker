// Runs migration 015 in real Postgres (PGlite): gym preferences, the expiry-reminder message and
// log, member balances, the gym summary and one current member per phone number, all per gym.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMigratedDatabase } from "./helpers/database.js";

const ownerA = "00000000-0000-4000-8000-00000000000a";
const ownerB = "00000000-0000-4000-8000-00000000000b";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
const migration015 = readFileSync(new URL("../migrations/015_move_browser_data_to_database.sql", import.meta.url), "utf8");
let db;
let today;
let codeCounter = 0;

async function addMember(gymId, name, phone, { consent = false, joined } = {}) {
    const { rows } = await db.query(
        `INSERT INTO public.members (gym_id, member_code, full_name, phone${joined ? ", created_at" : ""})
         VALUES ($1, $2, $3, $4${joined ? ", $5::timestamptz" : ""}) RETURNING id`,
        [gymId, `GP-${++codeCounter}`, name, phone, ...(joined ? [joined] : [])]
    );
    if (consent) await db.query("SELECT * FROM public.gympulse_set_member_whatsapp_consent($1, $2, true, 'staff_form', NULL)", [gymId, rows[0].id]);
    return rows[0].id;
}

async function addPlan(gymId, name, days, price) {
    const { rows } = await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, $2, $3, $4) RETURNING id", [gymId, name, days, price]);
    return rows[0].id;
}

async function assign(gymId, memberId, planId, startDate, fee = null) {
    const { rows } = await db.query("SELECT * FROM public.gympulse_assign_member_plan($1, $2, $3::date, $4, $5)", [memberId, planId, startDate, gymId, fee]);
    return rows[0];
}

const pay = (gymId, memberId, membershipId, amount, paidOn = today) => db.query(
    "INSERT INTO public.payments (gym_id, member_id, membership_id, amount, paid_on, method) VALUES ($1, $2, $3, $4, $5::date, 'cash')",
    [gymId, memberId, membershipId, amount, paidOn]
);

// A payment saved before migration 025, which now refuses paying more than is due: such data can
// still exist (an overpaid member), and balances must stay right for it.
const payBefore025 = async (...args) => {
    await db.exec("ALTER TABLE public.payments DISABLE TRIGGER payments_within_balance");
    try { return await pay(...args); } finally { await db.exec("ALTER TABLE public.payments ENABLE TRIGGER payments_within_balance"); }
};

const isoDate = (value) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
const shift = (date, days) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
};

async function asOwner(ownerId, work) {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${ownerId}', false);`);
    try {
        return await work();
    } finally {
        await db.exec("RESET ROLE;");
    }
}

before(async () => {
    db = await createMigratedDatabase();
    today = isoDate((await db.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d")).rows[0].d);
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${ownerA}', 'a@example.test'), ('${ownerB}', 'b@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'Gym A', '${ownerA}'), ('${gymB}', 'Gym B', '${ownerB}');
        INSERT INTO public.gym_users (gym_id, user_id) VALUES ('${gymA}', '${ownerA}'), ('${gymB}', '${ownerB}');
    `);
});

test("migration 015 can be run again without errors or changes", async () => {
    await db.exec(migration015);
    await db.exec(migration015);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'members_gym_phone_key'");
    assert.equal(rows[0].n, 1);
});

test("gym preferences are optional, checked, and NULL until chosen", async () => {
    await db.query("INSERT INTO public.gym_settings (gym_id) VALUES ($1)", [gymA]);
    const { rows } = await db.query("SELECT language, date_format, expiry_reminder_days, payment_reminders, inactivity_reminders FROM public.gym_settings WHERE gym_id = $1", [gymA]);
    assert.deepEqual(rows[0], { language: null, date_format: null, expiry_reminder_days: null, payment_reminders: null, inactivity_reminders: null });
    await db.query("UPDATE public.gym_settings SET language = 'mr', date_format = 'DD/MM/YYYY', expiry_reminder_days = 10 WHERE gym_id = $1", [gymA]);
    await assert.rejects(db.query("UPDATE public.gym_settings SET language = 'ta' WHERE gym_id = $1", [gymA]), /language_valid/);
    await assert.rejects(db.query("UPDATE public.gym_settings SET date_format = 'MM/DD/YYYY' WHERE gym_id = $1", [gymA]), /date_format_valid/);
    await assert.rejects(db.query("UPDATE public.gym_settings SET expiry_reminder_days = 91 WHERE gym_id = $1", [gymA]), /reminder_days_range/);
});

test("the expiry reminder message is a template key next to the welcome message", async () => {
    await db.query("INSERT INTO public.gym_message_templates (gym_id, template_key, language, body) VALUES ($1, 'expiry_reminder', 'hi', 'नमस्ते {name}')", [gymA]);
    await assert.rejects(db.query("INSERT INTO public.gym_message_templates (gym_id, template_key, language, body) VALUES ($1, 'promo', 'en', 'Sale')", [gymA]), /key_valid/);
});

test("an expiry reminder is logged against the member's own membership and needs consent", async () => {
    const plan = await addPlan(gymA, "Reminder plan", 30, 900);
    const riya = await addMember(gymA, "Riya Shah", "9876500101", { consent: true });
    const dev = await addMember(gymA, "Dev Rao", "9876500102");
    const riyaMembership = await assign(gymA, riya, plan, today);
    const devMembership = await assign(gymA, dev, plan, today);
    const log = (memberId, membership) => db.query(
        "INSERT INTO public.whatsapp_messages (gym_id, member_id, reminder_type, membership_id, membership_end_date) VALUES ($1, $2, 'expiry', $3, $4) RETURNING *",
        [gymA, memberId, membership?.id ?? null, membership?.end_date ?? null]
    );
    const { rows } = await log(riya, riyaMembership);
    assert.equal(rows[0].membership_id, riyaMembership.id);
    await assert.rejects(log(riya, null), /expiry_has_membership/);
    await assert.rejects(log(riya, devMembership), /does not belong to this member/);
    await assert.rejects(log(dev, devMembership), /not agreed to receive WhatsApp/);
});

test("member balances add every non-cancelled membership fee and subtract every payment", async () => {
    const plan = await addPlan(gymB, "Balance plan", 30, 1000);
    const asha = await addMember(gymB, "Asha Nair", "9876500201");
    const omar = await addMember(gymB, "Omar Khan", "9876500202");
    const first = await assign(gymB, asha, plan, shift(today, -40));
    const second = await assign(gymB, asha, plan, shift(today, -5), 800);
    const omarMembership = await assign(gymB, omar, plan, today);
    await pay(gymB, asha, first.id, 1000);
    await pay(gymB, asha, second.id, 300);
    await payBefore025(gymB, omar, omarMembership.id, 1200);
    await db.query("UPDATE public.member_memberships SET status = 'cancelled' WHERE id = $1", [omarMembership.id]);
    const { rows } = await db.query("SELECT member_id, billed::float, paid::float, outstanding::float FROM public.member_balances WHERE gym_id = $1", [gymB]);
    const byMember = Object.fromEntries(rows.map((row) => [row.member_id, [row.billed, row.paid, row.outstanding]]));
    assert.deepEqual(byMember[asha], [1800, 1300, 500]);
    assert.deepEqual(byMember[omar], [0, 1200, 0], "an overpaid member owes nothing; the balance never goes below zero");
});

test("the gym summary covers every member of that gym, in India dates", async () => {
    const plan = await addPlan(gymB, "Summary plan", 30, 1500);
    const kabir = await addMember(gymB, "Kabir Mehta", "9876500203");
    const lapsed = await addMember(gymB, "Lapsed Member", "9876500204", { joined: `${shift(today, -100)}T06:00:00Z` });
    const kabirMembership = await assign(gymB, kabir, plan, shift(today, -3));
    await assign(gymB, lapsed, plan, shift(today, -40));
    await pay(gymB, kabir, kabirMembership.id, 500);
    await db.query("INSERT INTO public.attendance (gym_id, member_id, method, membership_status_at_check_in) VALUES ($1, $2, 'manual', 'active')", [gymB, kabir]);
    const archived = await addMember(gymB, "Archived Member", "9876500205");
    await db.query("UPDATE public.members SET archived_at = now() WHERE id = $1", [archived]);

    const summary = (await db.query("SELECT public.gympulse_gym_summary($1, 6) AS s", [gymB])).rows[0].s;
    assert.equal(summary.total_members, 4, "archived members are not counted");
    assert.equal(summary.active_members, 2, "Asha (second membership) and Kabir");
    assert.equal(Number(summary.outstanding_total), 500 + 1000 + 1500, "Asha, Kabir and the lapsed member; Omar owes nothing");
    assert.equal(Number(summary.collected_this_month) > 0, true);
    assert.equal(summary.months.length, 6);
    assert.equal(summary.months.at(-1).month, today.slice(0, 7));
    assert.equal(Number(summary.months.at(-1).outstanding), 3000);
    assert.equal(summary.due_last_30_days, 2, "Asha's first plan and the lapsed member's plan ended within 30 days");
    assert.equal(summary.renewed_last_30_days, 1, "only Asha has a later membership");
    assert.equal(summary.inactive_members, 1, "Asha has a current plan and no visit; Kabir visited today");
    assert.ok(summary.active_by_plan.some((row) => row.plan_name === "Summary plan" && row.members === 1));
    assert.ok(summary.renewals_this_month >= 1, "Asha's second membership is a renewal");

    const other = (await db.query("SELECT public.gympulse_gym_summary($1, 3) AS s", [gymA])).rows[0].s;
    assert.equal(other.months.length, 3);
    assert.equal(other.total_members, 2, "gym A's summary never includes gym B");
});

test("one current member per phone number in a gym; +91 and spacing count as the same number", async () => {
    await addMember(gymA, "First Holder", "9876500301");
    await assert.rejects(addMember(gymA, "Second Holder", "+91 98765 00301"), /members_gym_phone_key/);
    await addMember(gymB, "Other Gym Holder", "9876500301");
    const leaving = await addMember(gymA, "Leaving Member", "9876500302");
    await db.query("UPDATE public.members SET archived_at = now() WHERE id = $1", [leaving]);
    await addMember(gymA, "New Holder", "9876500302");
});

test("a database that already has duplicate phones skips the phone index instead of failing", async () => {
    const duplicated = await createMigratedDatabase({ upTo: "014_add_member_photos.sql" });
    await duplicated.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${ownerA}', 'a@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'Gym A', '${ownerA}');
        INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES
            ('${gymA}', 'GP-1', 'One', '9876500101'), ('${gymA}', 'GP-2', 'Two', '+91 98765 00101');
    `);
    await duplicated.exec(migration015);
    assert.equal((await duplicated.query("SELECT to_regclass('public.members_gym_phone_key') AS idx")).rows[0].idx, null);
});

test("owners read only their own gym's balances; the summary is backend-only", async () => {
    const gyms = await asOwner(ownerA, async () => (await db.query("SELECT DISTINCT gym_id FROM public.member_balances")).rows.map((row) => row.gym_id));
    assert.deepEqual(gyms, [gymA]);
    await asOwner(ownerA, () => assert.rejects(db.query("SELECT public.gympulse_gym_summary($1)", [gymA]), /permission denied/));
    await db.exec("SET ROLE anon;");
    try {
        await assert.rejects(db.query("SELECT * FROM public.member_balances"), /permission denied/);
    } finally {
        await db.exec("RESET ROLE;");
    }
});
