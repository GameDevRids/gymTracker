// Runs migration 018 in real Postgres (PGlite): the demo reset empties one gym's records, even
// the ones ordinary deletes refuse, keeps the gym and its accounts, and needs its confirmation.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createMigratedDatabase } from "./helpers/database.js";
import { demoVisits } from "../scripts/seed-demo.js";

const owner = "00000000-0000-4000-8000-00000000000a";
const otherOwner = "00000000-0000-4000-8000-00000000000b";
const demoGym = "00000000-0000-4000-8000-0000000000a1";
const otherGym = "00000000-0000-4000-8000-0000000000b1";
let db;

const count = async (table, gymId) => (await db.query(`SELECT count(*)::int AS n FROM public.${table} WHERE gym_id = $1`, [gymId])).rows[0].n;

async function fill(gymId, prefix) {
    const today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).rows[0].d;
    const plan = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 1000) RETURNING id", [gymId])).rows[0].id;
    await db.query("SELECT public.gympulse_import_members($1, $2::jsonb)", [gymId, JSON.stringify({
        rows: [{ row: 2, full_name: "Demo Member", phone: `${prefix}1`, notes: null, plan: { id: plan }, start_date: today, end_date: null, amount_paid: 500 }]
    })]);
    const member = (await db.query("SELECT id FROM public.members WHERE gym_id = $1", [gymId])).rows[0].id;
    await db.query("SELECT * FROM public.gympulse_set_member_whatsapp_consent($1, $2, true, 'staff_form', NULL)", [gymId, member]);
    await db.query("INSERT INTO public.attendance (gym_id, member_id, method, membership_status_at_check_in) VALUES ($1, $2, 'manual', 'active')", [gymId, member]);
    await db.query("INSERT INTO public.member_devices (gym_id, member_id, device_secret_hash) VALUES ($1, $2, $3)", [gymId, member, "b".repeat(64)]);
}

before(async () => {
    db = await createMigratedDatabase();
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${owner}', 'demo@example.test'), ('${otherOwner}', 'real@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${demoGym}', 'Demo Gym', '${owner}'), ('${otherGym}', 'Real Gym', '${otherOwner}');
        INSERT INTO public.gym_users (gym_id, user_id) VALUES ('${demoGym}', '${owner}'), ('${otherGym}', '${otherOwner}');
    `);
    await db.query("INSERT INTO public.gym_settings (gym_id) VALUES ($1), ($2)", [demoGym, otherGym]);
    await fill(demoGym, "987650000");
    await fill(otherGym, "987651110");
});

test("the reset refuses without its exact confirmation, and for anyone but the service role", async () => {
    await assert.rejects(db.query("SELECT public.gympulse_reset_demo_gym($1, $2)", [demoGym, "yes"]), /RESET DEMO/);
    await assert.rejects(db.query("SELECT public.gympulse_reset_demo_gym($1, $2)", [demoGym, `RESET DEMO ${otherGym}`]), /RESET DEMO/);
    await db.exec("SET ROLE authenticated");
    try {
        await assert.rejects(db.query("SELECT public.gympulse_reset_demo_gym($1, $2)", [demoGym, `RESET DEMO ${demoGym}`]), /permission denied/);
    } finally {
        await db.exec("RESET ROLE");
    }
    assert.equal(await count("members", demoGym), 1);
});

test("the reset empties the demo gym's records and keeps the gym, settings, accounts and other gyms", async () => {
    const otherBefore = await Promise.all(["members", "payments", "attendance", "member_consent_events"].map((table) => count(table, otherGym)));
    await db.exec("SET ROLE service_role");
    try {
        await db.query("SELECT public.gympulse_reset_demo_gym($1, $2)", [demoGym, `RESET DEMO ${demoGym}`]);
    } finally {
        await db.exec("RESET ROLE");
    }
    for (const table of ["attendance", "payments", "gym_receipt_counters", "member_consent_events", "member_memberships", "member_devices", "members", "membership_plans"]) {
        assert.equal(await count(table, demoGym), 0, table);
    }
    assert.equal(await count("gym_settings", demoGym), 1);
    assert.equal(await count("gym_users", demoGym), 1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.gyms WHERE id = $1", [demoGym])).rows[0].n, 1);
    assert.deepEqual(await Promise.all(["members", "payments", "attendance", "member_consent_events"].map((table) => count(table, otherGym))), otherBefore);
    // Filling it again works, and receipt numbers start over.
    await fill(demoGym, "987650000");
    assert.equal((await db.query("SELECT receipt_number FROM public.payments WHERE gym_id = $1", [demoGym])).rows[0].receipt_number, "R-000001");
});

test("demo check-ins fall only inside each member's plan, within the last 30 days", () => {
    const members = [
        { id: "m0", startDate: "2026-10-01", endDate: "2026-12-31" },
        { id: "m1", startDate: "2026-11-10", endDate: "2026-11-14" },
        { id: "m2", startDate: "2026-12-01", endDate: "2026-12-31" }
    ];
    const visits = demoVisits(members, "2026-11-16");
    assert.ok(visits.some((visit) => visit.member_id === "m0"));
    assert.ok(visits.every((visit) => visit.member_id !== "m2"), "a plan that has not started has no visits");
    for (const visit of visits) {
        const day = visit.checked_in_at.slice(0, 10);
        const member = members.find((item) => item.id === visit.member_id);
        assert.ok(day >= member.startDate && day <= member.endDate && day >= "2026-10-18" && day <= "2026-11-16", visit.checked_in_at);
        assert.match(visit.checked_in_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+05:30$/);
    }
});
