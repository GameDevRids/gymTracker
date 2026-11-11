// Runs migration 009 in real Postgres (PGlite) to check consent state, history and gym isolation.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { applyMigration, createMigratedDatabase, migrationFiles } from "./helpers/database.js";

const MIGRATION = "009_add_member_contact_and_whatsapp_consent.sql";
const ownerA = "00000000-0000-4000-8000-00000000000a";
const ownerB = "00000000-0000-4000-8000-00000000000b";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
const existingMember = "00000000-0000-4000-8000-0000000000e1";
let db;

async function addMember(gymId, name, phone) {
    const { rows } = await db.query(
        "INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING id",
        [gymId, `GP-${phone}`, name, phone]
    );
    return rows[0].id;
}

const setConsent = (gymId, memberId, optIn, source = "staff_form", recordedBy = ownerA) => db.query(
    "SELECT * FROM public.gympulse_set_member_whatsapp_consent($1, $2, $3, $4, $5)",
    [gymId, memberId, optIn, source, recordedBy]
);
const events = async (memberId) => (await db.query(
    "SELECT action, source, recorded_by, created_at FROM public.member_consent_events WHERE member_id = $1 ORDER BY created_at, action",
    [memberId]
)).rows;
const member = async (memberId) => (await db.query(
    "SELECT whatsapp_opt_in, whatsapp_opt_in_at, whatsapp_opt_out_at FROM public.members WHERE id = $1", [memberId]
)).rows[0];

before(async () => {
    const previous = migrationFiles().filter((name) => name < MIGRATION).at(-1);
    db = await createMigratedDatabase({ upTo: previous });
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${ownerA}', 'a@example.test'), ('${ownerB}', 'b@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'Gym A', '${ownerA}'), ('${gymB}', 'Gym B', '${ownerB}');
        INSERT INTO public.gym_users (gym_id, user_id) VALUES ('${gymA}', '${ownerA}'), ('${gymB}', '${ownerB}');
        INSERT INTO public.members (id, gym_id, member_code, full_name, phone)
            VALUES ('${existingMember}', '${gymA}', 'GP-OLD', 'Existing Member', '9876500000');
    `);
    await applyMigration(db, MIGRATION);
});

test("existing members start without consent and without history", async () => {
    assert.deepEqual(await member(existingMember), { whatsapp_opt_in: false, whatsapp_opt_in_at: null, whatsapp_opt_out_at: null });
    assert.deepEqual(await events(existingMember), []);
    const { rows } = await db.query("SELECT follow_up_status, emergency_contact FROM public.members WHERE id = $1", [existingMember]);
    assert.deepEqual(rows[0], { follow_up_status: "pending", emergency_contact: null });
});

test("opting in writes one 'granted' event with its source and who recorded it", async () => {
    const id = await addMember(gymA, "Riya Shah", "9876500001");
    const { rows } = await setConsent(gymA, id, true, "csv_import");
    assert.equal(rows[0].whatsapp_opt_in, true);
    assert.ok(rows[0].whatsapp_opt_in_at instanceof Date);
    const history = await events(id);
    assert.equal(history.length, 1);
    assert.equal(history[0].action, "granted");
    assert.equal(history[0].source, "csv_import");
    assert.equal(history[0].recorded_by, ownerA);
    assert.equal(history[0].created_at.getTime(), rows[0].whatsapp_opt_in_at.getTime());
});

test("opting out writes 'withdrawn', sets whatsapp_opt_out_at and keeps the opt-in time", async () => {
    const id = await addMember(gymA, "Dev Rao", "9876500002");
    const granted = (await setConsent(gymA, id, true)).rows[0];
    const withdrawn = (await setConsent(gymA, id, false, "member_reply_stop", null)).rows[0];
    assert.equal(withdrawn.whatsapp_opt_in, false);
    assert.ok(withdrawn.whatsapp_opt_out_at instanceof Date);
    assert.equal(withdrawn.whatsapp_opt_in_at.getTime(), granted.whatsapp_opt_in_at.getTime());
    const history = await events(id);
    assert.deepEqual(history.map((event) => event.action), ["granted", "withdrawn"]);
    assert.equal(history[1].source, "member_reply_stop");
    assert.equal(history[1].recorded_by, null);
});

test("repeating the current choice adds no history", async () => {
    const id = await addMember(gymA, "Aisha Khan", "9876500003");
    await setConsent(gymA, id, false);
    assert.deepEqual(await events(id), []);
    await setConsent(gymA, id, true);
    await setConsent(gymA, id, true);
    assert.equal((await events(id)).length, 1);
});

test("consent cannot change, or be faked, outside the consent function", async () => {
    const id = await addMember(gymA, "Kabir Mehta", "9876500004");
    await assert.rejects(db.query("UPDATE public.members SET whatsapp_opt_in = true WHERE id = $1", [id]), /gympulse_set_member_whatsapp_consent/);
    await assert.rejects(
        db.query("INSERT INTO public.members (gym_id, member_code, full_name, phone, whatsapp_opt_in) VALUES ($1, 'GP-X', 'Tara Iyer', '9876500005', true)", [gymA]),
        /start without WhatsApp consent/
    );
    await db.query("UPDATE public.members SET whatsapp_opt_in_at = now(), notes = 'edited' WHERE id = $1", [id]);
    assert.equal((await member(id)).whatsapp_opt_in_at, null);
    await assert.rejects(setConsent(gymA, id, true, "made_up"), /Unknown consent source/);
    await assert.rejects(setConsent(gymB, id, true), /Member not found/);
    assert.deepEqual(await events(id), []);
});

test("consent history is append-only, even for the database owner", async () => {
    const id = await addMember(gymA, "Neha Joshi", "9876500006");
    await setConsent(gymA, id, true);
    await assert.rejects(db.query("UPDATE public.member_consent_events SET action = 'withdrawn' WHERE member_id = $1", [id]), /append-only/);
    await assert.rejects(db.query("DELETE FROM public.member_consent_events WHERE member_id = $1", [id]), /append-only/);
    await assert.rejects(db.query("TRUNCATE public.member_consent_events"), /append-only/);
    await assert.rejects(db.query("DELETE FROM public.members WHERE id = $1", [id]), /foreign key/);
    assert.equal((await events(id)).length, 1);
});

test("gym A's owner cannot read gym B's consent events or change consent directly", async () => {
    const memberA = await addMember(gymA, "Owner A Member", "9876500007");
    const memberB = await addMember(gymB, "Owner B Member", "9876500008");
    await setConsent(gymA, memberA, true);
    await setConsent(gymB, memberB, true, "staff_form", ownerB);

    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${ownerA}', false);`);
    try {
        const visible = (await db.query("SELECT DISTINCT gym_id FROM public.member_consent_events")).rows.map((row) => row.gym_id);
        assert.deepEqual(visible, [gymA]);
        assert.deepEqual((await db.query("SELECT * FROM public.member_consent_events WHERE member_id = $1", [memberB])).rows, []);
        await assert.rejects(
            db.query("INSERT INTO public.member_consent_events (gym_id, member_id, channel, action, source) VALUES ($1, $2, 'whatsapp', 'granted', 'staff_form')", [gymA, memberA]),
            /permission denied/
        );
        await assert.rejects(db.query("SELECT * FROM public.gympulse_set_member_whatsapp_consent($1, $2, false, 'staff_form', NULL)", [gymA, memberA]), /permission denied/);
        await assert.rejects(db.query("UPDATE public.members SET whatsapp_opt_in = false WHERE id = $1", [memberA]), /gympulse_set_member_whatsapp_consent/);
    } finally {
        await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);");
    }
});
