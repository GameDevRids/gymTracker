// Migration 024 in real Postgres (PGlite): the enquiries table, its one-gym rules, the 90-day cleanup,
// who may read and write, consent carried to a member, and gym deletion and demo reset.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMigratedDatabase } from "./helpers/database.js";

const owner = "00000000-0000-4000-8000-00000000000a";
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";
let db;
let planA;
let planB;
let memberA;
let memberB;
const add = (gym, phone, extra = {}) => db.query(
    "INSERT INTO public.enquiries (gym_id, full_name, phone, interest_plan_id, source, stage, whatsapp_consent, whatsapp_consent_at, joined_member_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
    [gym, extra.name ?? "Visitor", phone, extra.plan ?? null, extra.source ?? "walk_in", extra.stage ?? "new", extra.consent ?? false, extra.consent ? new Date().toISOString() : null, extra.member ?? null]).then((result) => result.rows[0]);
const ids = async (gym) => new Set((await db.query("SELECT id FROM public.enquiries WHERE gym_id = $1", [gym])).rows.map((row) => row.id));
const age = async (rows, days) => {
    await db.exec("ALTER TABLE public.enquiries DISABLE TRIGGER enquiries_touch");
    await db.query("UPDATE public.enquiries SET updated_at = now() - make_interval(days => $2) WHERE id = ANY($1)", [rows.map((row) => row.id), days]);
    await db.exec("ALTER TABLE public.enquiries ENABLE TRIGGER enquiries_touch");
};

before(async () => {
    db = await createMigratedDatabase();
    await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${owner}', 'o@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${A}', 'A', '${owner}'), ('${B}', 'B', '${owner}');
        INSERT INTO public.gym_users (gym_id, user_id, role) VALUES ('${A}', '${owner}', 'owner');`);
    planA = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 1000) RETURNING id", [A])).rows[0].id;
    planB = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 1000) RETURNING id", [B])).rows[0].id;
    memberA = (await db.query("INSERT INTO public.members (gym_id, full_name, phone) VALUES ($1, 'Riya', '9876543210') RETURNING id", [A])).rows[0].id;
    memberB = (await db.query("INSERT INTO public.members (gym_id, full_name, phone) VALUES ($1, 'Dev', '9876543211') RETURNING id", [B])).rows[0].id;
});

test("running 024 again changes nothing", async () => {
    const before = (await db.query("SELECT count(*)::int AS c FROM public.enquiries")).rows[0].c;
    await db.exec(readFileSync(new URL("../migrations/024_add_enquiries.sql", import.meta.url), "utf8"));
    assert.equal((await db.query("SELECT count(*)::int AS c FROM public.enquiries")).rows[0].c, before);
});

test("an enquiry with consent and a plan of its own gym", async () => {
    const row = await add(A, "+919811111111", { plan: planA, consent: true });
    assert.equal(row.whatsapp_consent, true);
    assert.ok(row.whatsapp_consent_at);
    assert.equal(row.interest_plan_id, planA);
    assert.equal(row.stage, "new");
});

test("the same phone is an open enquiry once per gym; again in another gym, or after it closes", async () => {
    const first = await add(A, "+919822222222");
    await assert.rejects(add(A, "+919822222222"), /enquiries_one_open_per_phone/);
    assert.ok(await add(B, "+919822222222"));
    await db.query("UPDATE public.enquiries SET stage = 'not_interested' WHERE id = $1", [first.id]);
    assert.ok(await add(A, "+919822222222"), "a closed enquiry does not block a new one");
});

test("another gym's plan or member is refused", async () => {
    await assert.rejects(add(A, "+919833333333", { plan: planB }), /enquiries_plan_fkey/);
    await assert.rejects(add(A, "+919833333334", { stage: "joined", member: memberB }), /enquiries_member_fkey/);
});

test("phone, source, stage, consent date and joined member are checked", async () => {
    await assert.rejects(add(A, "9844444444"), /enquiries_phone_valid/);
    await assert.rejects(add(A, "+915844444444"), /enquiries_phone_valid/);
    await assert.rejects(add(A, "+919855555555", { source: "tv" }), /enquiries_source_valid/);
    await assert.rejects(add(A, "+919855555556", { stage: "maybe" }), /enquiries_stage_valid/);
    await assert.rejects(db.query("INSERT INTO public.enquiries (gym_id, full_name, phone, whatsapp_consent) VALUES ($1, 'X', '+919866666666', true)", [A]), /enquiries_consent_date/);
    await assert.rejects(add(A, "+919877777777", { member: memberA }), /enquiries_joined_member/);
});

test("updated_at moves on every change", async () => {
    const row = await add(A, "+919811110000");
    await age([row], 5);
    await db.query("UPDATE public.enquiries SET note = 'called' WHERE id = $1", [row.id]);
    const after = (await db.query("SELECT updated_at > now() - interval '1 minute' AS fresh FROM public.enquiries WHERE id = $1", [row.id])).rows[0].fresh;
    assert.equal(after, true);
});

test("the 90-day cleanup deletes only old enquiries that did not join, in the gym asked", async () => {
    const old = await add(A, "+919888888881", { stage: "contacted" });
    const oldNotInterested = await add(A, "+919888888882", { stage: "not_interested" });
    const oldJoined = await add(A, "+919888888883", { stage: "joined", member: memberA });
    const recent = await add(A, "+919888888884");
    const otherGym = await add(B, "+919888888885");
    await age([old, oldNotInterested, oldJoined, otherGym], 91);
    await age([recent], 89);
    assert.equal((await db.query("SELECT public.gympulse_purge_old_enquiries($1) AS n", [A])).rows[0].n, 2);
    const left = await ids(A);
    assert.equal(left.has(old.id) || left.has(oldNotInterested.id), false);
    assert.ok(left.has(oldJoined.id), "joined enquiries are kept");
    assert.ok(left.has(recent.id), "89 days is not yet 90");
    assert.ok((await ids(B)).has(otherGym.id), "another gym is not touched");
    assert.equal((await db.query("SELECT public.gympulse_purge_old_enquiries() AS n")).rows[0].n, 1, "null: every gym");
    assert.equal((await ids(B)).has(otherGym.id), false);
    assert.equal((await db.query("SELECT count(*)::int AS c FROM public.members")).rows[0].c, 2, "members are never touched");
});

test("the app's roles can't write; a gym user reads only their own gym's enquiries", async () => {
    const yes = async (sql) => (await db.query(sql)).rows[0].ok;
    assert.equal(await yes("SELECT has_table_privilege('authenticated', 'public.enquiries', 'insert') AS ok"), false);
    assert.equal(await yes("SELECT has_table_privilege('anon', 'public.enquiries', 'select') AS ok"), false);
    assert.equal(await yes("SELECT relrowsecurity AS ok FROM pg_class WHERE relname = 'enquiries'"), true);
    assert.equal(await yes("SELECT has_function_privilege('authenticated', 'public.gympulse_purge_old_enquiries(uuid)', 'execute') AS ok"), false);
    assert.equal(await yes("SELECT has_function_privilege('service_role', 'public.gympulse_purge_old_enquiries(uuid)', 'execute') AS ok"), true);
    await add(B, "+919800000099");
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${owner}', false);`);
    try {
        const gyms = (await db.query("SELECT DISTINCT gym_id FROM public.enquiries")).rows.map((row) => row.gym_id);
        assert.deepEqual(gyms, [A]);
    } finally {
        await db.exec("RESET ROLE");
    }
});

test("consent carried from an enquiry is recorded as 'enquiry' in the member's history", async () => {
    await db.query("SELECT * FROM public.gympulse_set_member_whatsapp_consent($1, $2, true, 'enquiry', $3)", [A, memberA, owner]);
    const event = (await db.query("SELECT source, action FROM public.member_consent_events WHERE member_id = $1 AND channel = 'whatsapp' ORDER BY created_at DESC LIMIT 1", [memberA])).rows[0];
    assert.deepEqual(event, { source: "enquiry", action: "granted" });
    await assert.rejects(db.query("SELECT * FROM public.gympulse_set_member_whatsapp_consent($1, $2, false, 'made_up', $3)", [A, memberA, owner]), /Unknown consent source/);
});

test("the enquiry follow-up message can be saved as a template", async () => {
    await db.query("INSERT INTO public.gym_message_templates (gym_id, template_key, language, body) VALUES ($1, 'enquiry_followup', 'en', 'Hi {name}')", [A]);
    await assert.rejects(db.query("INSERT INTO public.gym_message_templates (gym_id, template_key, language, body) VALUES ($1, 'nope', 'en', 'Hi')", [A]), /gym_message_templates_key_valid/);
});

test("resetting the demo gym clears its enquiries; deleting a gym deletes them all", async () => {
    await db.query("SELECT public.gympulse_reset_demo_gym($1, $2)", [A, `RESET DEMO ${A}`]);
    assert.equal((await ids(A)).size, 0);
    const member = (await db.query("SELECT id FROM public.members WHERE gym_id = $1", [B])).rows[0].id;
    await add(B, "+919800000100", { stage: "joined", member });
    await db.query("UPDATE public.gyms SET deletion_requested_at = now() - interval '8 days', deletion_requested_by = $2, deletion_scheduled_for = now() - interval '1 day' WHERE id = $1", [B, owner]);
    await db.query("SELECT public.gympulse_delete_gym($1)", [B]);
    assert.equal((await db.query("SELECT count(*)::int AS c FROM public.enquiries WHERE gym_id = $1", [B])).rows[0].c, 0);
});
