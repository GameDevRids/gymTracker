// Runs migration 017 in real Postgres (PGlite): agreeing to the Terms is recorded once per
// version, and deleting a gym erases only that gym, all at once, and only after its 7 days.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createMigratedDatabase } from "./helpers/database.js";

const ownerA = "00000000-0000-4000-8000-00000000000a";
const staffA = "00000000-0000-4000-8000-00000000000c";
const ownerB = "00000000-0000-4000-8000-00000000000b";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
const TABLES = ["attendance", "whatsapp_messages", "payments", "member_consent_events", "member_memberships",
    "member_devices", "members", "membership_plans", "gym_message_templates", "gym_receipt_counters", "gym_settings", "gym_users"];
let db;

const count = async (table, gymId) => (await db.query(`SELECT count(*)::int AS n FROM public.${table} WHERE gym_id = $1`, [gymId])).rows[0].n;
const counts = async (gymId) => Object.fromEntries(await Promise.all(TABLES.map(async (table) => [table, await count(table, gymId)])));

// A gym with something in every table the deletion has to clear.
async function fillGym(gymId, phonePrefix) {
    const today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).rows[0].d;
    const plan = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 1000) RETURNING id", [gymId])).rows[0].id;
    await db.query("SELECT public.gympulse_import_members($1, $2::jsonb)", [gymId, JSON.stringify({
        rows: [1, 2].map((n) => ({ row: n + 1, full_name: `Member ${n}`, phone: `${phonePrefix}${n}`, notes: null, plan: { id: plan }, start_date: today, end_date: null, amount_paid: 500 }))
    })]);
    const members = (await db.query("SELECT id FROM public.members WHERE gym_id = $1 ORDER BY phone", [gymId])).rows;
    const membership = (await db.query("SELECT id, end_date FROM public.member_memberships WHERE member_id = $1", [members[0].id])).rows[0];
    await db.query("SELECT * FROM public.gympulse_set_member_whatsapp_consent($1, $2, true, 'staff_form', NULL)", [gymId, members[0].id]);
    await db.query("INSERT INTO public.whatsapp_messages (gym_id, member_id, reminder_type, membership_id, membership_end_date) VALUES ($1, $2, 'expiry', $3, $4)",
        [gymId, members[0].id, membership.id, membership.end_date]);
    await db.query("INSERT INTO public.attendance (gym_id, member_id, method, membership_status_at_check_in) VALUES ($1, $2, 'manual', 'active')", [gymId, members[1].id]);
    await db.query("INSERT INTO public.member_devices (gym_id, member_id, device_secret_hash) VALUES ($1, $2, $3)", [gymId, members[1].id, "a".repeat(64)]);
    await db.query("INSERT INTO public.gym_settings (gym_id) VALUES ($1) ON CONFLICT DO NOTHING", [gymId]);
    await db.query("INSERT INTO public.gym_message_templates (gym_id, template_key, language, body) VALUES ($1, 'welcome', 'en', 'Hi {name}')", [gymId]);
}

async function schedule(gymId, daysAgo) {
    await db.query(`UPDATE public.gyms SET deletion_requested_at = now() - make_interval(days => $2),
        deletion_scheduled_for = now() - make_interval(days => $2) + interval '7 days', deletion_requested_by = $3 WHERE id = $1`,
    [gymId, daysAgo, gymId === gymA ? ownerA : ownerB]);
}

before(async () => {
    db = await createMigratedDatabase();
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${ownerA}', 'a@example.test'), ('${staffA}', 'c@example.test'), ('${ownerB}', 'b@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'Gym A', '${ownerA}'), ('${gymB}', 'Gym B', '${ownerB}');
        INSERT INTO public.gym_users (gym_id, user_id, role) VALUES ('${gymA}', '${ownerA}', 'owner'), ('${gymA}', '${staffA}', 'staff'), ('${gymB}', '${ownerB}', 'owner');
    `);
    await fillGym(gymA, "987650000");
    await fillGym(gymB, "987651110");
});

test("a Terms agreement is stored once per user and version, and only the server can write it", async () => {
    await db.query("INSERT INTO public.terms_acceptances (user_id, terms_version) VALUES ($1, '2026-11-16')", [ownerA]);
    await assert.rejects(db.query("INSERT INTO public.terms_acceptances (user_id, terms_version) VALUES ($1, '2026-11-16')", [ownerA]), /duplicate key/);
    await assert.rejects(db.query("INSERT INTO public.terms_acceptances (user_id, terms_version) VALUES ($1, 'v2')", [ownerA]), /terms_acceptances_version_format/);
    for (const role of ["authenticated", "anon"]) {
        await db.exec(`SET ROLE ${role}`);
        try {
            await assert.rejects(db.query("SELECT * FROM public.terms_acceptances"), /permission denied/);
        } finally {
            await db.exec("RESET ROLE");
        }
    }
    await db.exec("SET ROLE service_role");
    try {
        await assert.rejects(db.query("UPDATE public.terms_acceptances SET accepted_at = now()"), /permission denied/);
        await assert.rejects(db.query("DELETE FROM public.terms_acceptances"), /permission denied/);
    } finally {
        await db.exec("RESET ROLE");
    }
});

test("a deletion request must give the full 7 days, and the fields go together", async () => {
    await assert.rejects(db.query("UPDATE public.gyms SET deletion_requested_at = now(), deletion_scheduled_for = now() + interval '1 day', deletion_requested_by = $2 WHERE id = $1", [gymA, ownerA]), /gyms_deletion_after_7_days/);
    await assert.rejects(db.query("UPDATE public.gyms SET deletion_requested_at = now() WHERE id = $1", [gymA]), /gyms_deletion_fields_together/);
});

test("a gym cannot be erased before its 7 days have passed, or without a request", async () => {
    await assert.rejects(db.query("SELECT public.gympulse_delete_gym($1)", [gymA]), /not due for deletion/);
    await schedule(gymA, 3);
    await assert.rejects(db.query("SELECT public.gympulse_delete_gym($1)", [gymA]), /not due for deletion/);
    assert.equal(await count("members", gymA), 2);
});

test("only the service role can erase a gym", async () => {
    await db.exec("SET ROLE authenticated");
    try {
        await assert.rejects(db.query("SELECT public.gympulse_delete_gym($1)", [gymA]), /permission denied/);
    } finally {
        await db.exec("RESET ROLE");
    }
});

test("payments and consent history still refuse ordinary deletes", async () => {
    await assert.rejects(db.query("DELETE FROM public.payments WHERE gym_id = $1", [gymA]), /Payments cannot be deleted/);
    await assert.rejects(db.query("DELETE FROM public.member_consent_events WHERE gym_id = $1", [gymA]), /append-only/);
    // The allowance names one gym: set for gym B, it does not open gym A's rows.
    await db.exec("BEGIN");
    try {
        await db.query("SELECT set_config('gympulse.allow_gym_delete', $1, true)", [gymB]);
        await assert.rejects(db.query("DELETE FROM public.payments WHERE gym_id = $1", [gymA]), /Payments cannot be deleted/);
    } finally {
        await db.exec("ROLLBACK");
    }
});

test("a due gym is erased completely, its users are returned, and the other gym is untouched", async () => {
    const before = await counts(gymB);
    const full = await counts(gymA);
    assert.deepEqual(Object.keys(full).filter((table) => full[table] === 0), [], "gym A has data in every table");
    await schedule(gymA, 8);
    await db.exec("SET ROLE service_role");
    let users;
    try {
        users = (await db.query("SELECT public.gympulse_delete_gym($1) AS users", [gymA])).rows[0].users;
    } finally {
        await db.exec("RESET ROLE");
    }
    assert.deepEqual([...users].sort(), [ownerA, staffA].sort());
    assert.ok(Object.values(await counts(gymA)).every((n) => n === 0), JSON.stringify(await counts(gymA)));
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.gyms WHERE id = $1", [gymA])).rows[0].n, 0);
    assert.deepEqual(await counts(gymB), before);
    // The allowance ended with the transaction.
    await assert.rejects(db.query("DELETE FROM public.payments WHERE gym_id = $1", [gymB]), /Payments cannot be deleted/);
    // Terms agreements belong to the user, not the gym, so they stay until the account goes.
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.terms_acceptances WHERE user_id = $1", [ownerA])).rows[0].n, 1);
});

test("the migration can be run again", async () => {
    const { readFileSync } = await import("node:fs");
    await db.exec(readFileSync(new URL("../migrations/017_add_terms_and_gym_deletion.sql", import.meta.url), "utf8"));
});
