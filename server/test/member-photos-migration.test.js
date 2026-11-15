// Runs migration 014 in real Postgres (PGlite): photo columns, consent-first rules, gym-scoped
// file paths, photo consent history and the guard against browser roles writing photo columns.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { applyMigration, createMigratedDatabase, migrationFiles } from "./helpers/database.js";

const MIGRATION = "014_add_member_photos.sql";
const ownerA = "00000000-0000-4000-8000-00000000000a";
const ownerB = "00000000-0000-4000-8000-00000000000b";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
const existingMember = "00000000-0000-4000-8000-0000000000e1";
const RANDOM = "AbCdEfGhIjKlMnOpQrStUv12";
let db;
let phone = 9876500100;

async function addMember(gymId, name = "Riya Shah") {
    phone += 1;
    const { rows } = await db.query(
        "INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING id",
        [gymId, `GP-${phone}`, name, String(phone)]
    );
    return rows[0].id;
}

const setConsent = (gymId, memberId, consent, source = "desk", recordedBy = ownerA) => db.query(
    "SELECT * FROM public.gympulse_set_member_photo_consent($1, $2, $3, $4, $5)",
    [gymId, memberId, consent, source, recordedBy]
);
const photoPath = (gymId, memberId, ext = "jpg") => `${gymId}/${memberId}/${RANDOM}.${ext}`;
const setPhoto = (memberId, path, status = "approved") => db.query(
    "UPDATE public.members SET photo_path = $2, photo_status = $3, photo_updated_at = now() WHERE id = $1 RETURNING photo_path, photo_status",
    [memberId, path, status]
);
const photoEvents = async (memberId) => (await db.query(
    "SELECT action, source, recorded_by FROM public.member_consent_events WHERE member_id = $1 AND channel = 'photo' ORDER BY created_at, action",
    [memberId]
)).rows;
const row = async (memberId) => (await db.query(
    "SELECT photo_path, photo_status, photo_consent, photo_consent_at, photo_updated_at, photo_device_id FROM public.members WHERE id = $1",
    [memberId]
)).rows[0];

async function asOwner(userId, run) {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
    try {
        await run();
    } finally {
        await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);");
    }
}

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
    // Running it again changes nothing.
    await applyMigration(db, MIGRATION);
});

test("existing members start with no photo, no photo consent and no photo history", async () => {
    assert.deepEqual(await row(existingMember), {
        photo_path: null, photo_status: "none", photo_consent: false, photo_consent_at: null, photo_updated_at: null, photo_device_id: null
    });
    assert.deepEqual(await photoEvents(existingMember), []);
});

test("new members cannot start with a photo or photo consent", async () => {
    await assert.rejects(db.query(
        "INSERT INTO public.members (gym_id, member_code, full_name, phone, photo_consent) VALUES ($1, 'GP-X1', 'Ann Lee', '9876511111', true)", [gymA]
    ), /start without a photo/);
});

test("no photo can be saved without consent", async () => {
    const id = await addMember(gymA);
    await assert.rejects(setPhoto(id, photoPath(gymA, id)), /members_photo_needs_consent/);
});

test("granting consent writes one 'photo' event with its source; a repeat adds nothing", async () => {
    const id = await addMember(gymA);
    const granted = (await setConsent(gymA, id, true, "desk")).rows[0];
    assert.equal(granted.photo_consent, true);
    assert.ok(granted.photo_consent_at instanceof Date);
    await setConsent(gymA, id, true, "desk");
    assert.deepEqual(await photoEvents(id), [{ action: "granted", source: "desk", recorded_by: ownerA }]);
    // The member's WhatsApp consent is untouched.
    const { rows } = await db.query("SELECT whatsapp_opt_in FROM public.members WHERE id = $1", [id]);
    assert.equal(rows[0].whatsapp_opt_in, false);
});

test("the photo path must be inside this member's own gym and member folder", async () => {
    const id = await addMember(gymA);
    const other = await addMember(gymA, "Dev Rao");
    await setConsent(gymA, id, true);
    await assert.rejects(setPhoto(id, photoPath(gymB, id)), /members_photo_path_own_gym/, "another gym's folder");
    await assert.rejects(setPhoto(id, photoPath(gymA, other)), /members_photo_path_own_gym/, "another member's folder");
    await assert.rejects(setPhoto(id, `${gymA}/${id}/../x.jpg`), /members_photo_path_own_gym/);
    await assert.rejects(setPhoto(id, `${gymA}/${id}/${RANDOM}.png`), /members_photo_path_own_gym/);
    const saved = (await setPhoto(id, photoPath(gymA, id, "webp"))).rows[0];
    assert.deepEqual(saved, { photo_path: photoPath(gymA, id, "webp"), photo_status: "approved" });
});

test("status and path agree, and only pending photos remember the phone that sent them", async () => {
    const id = await addMember(gymA);
    await setConsent(gymA, id, true, "poster_page", null);
    await assert.rejects(setPhoto(id, null, "approved"), /members_photo_path_matches_status/);
    await assert.rejects(setPhoto(id, photoPath(gymA, id), "none"), /members_photo_path_matches_status/);
    await assert.rejects(db.query(
        "UPDATE public.members SET photo_path = $2, photo_status = 'approved', photo_updated_at = now(), photo_device_id = gen_random_uuid() WHERE id = $1",
        [id, photoPath(gymA, id)]
    ), /members_photo_device_only_pending/);
    await db.query(
        "UPDATE public.members SET photo_path = $2, photo_status = 'pending', photo_updated_at = now(), photo_device_id = gen_random_uuid() WHERE id = $1",
        [id, photoPath(gymA, id)]
    );
    assert.equal((await row(id)).photo_status, "pending");
    assert.deepEqual(await photoEvents(id), [{ action: "granted", source: "poster_page", recorded_by: null }]);
});

test("withdrawing consent clears the photo and writes a 'withdrawn' event", async () => {
    const id = await addMember(gymA);
    await setConsent(gymA, id, true);
    await setPhoto(id, photoPath(gymA, id));
    const withdrawn = (await setConsent(gymA, id, false, "desk")).rows[0];
    assert.equal(withdrawn.photo_consent, false);
    assert.equal(withdrawn.photo_consent_at, null);
    assert.equal(withdrawn.photo_path, null);
    assert.equal(withdrawn.photo_status, "none");
    assert.deepEqual((await photoEvents(id)).map((event) => event.action), ["granted", "withdrawn"]);
});

test("photo consent changes only through the consent function", async () => {
    const id = await addMember(gymA);
    await assert.rejects(db.query("UPDATE public.members SET photo_consent = true WHERE id = $1", [id]), /gympulse_set_member_photo_consent/);
    await assert.rejects(setConsent(gymA, id, true, "staff_form"), /Unknown consent source/);
    await assert.rejects(setConsent(gymB, id, true), /Member not found/, "another gym's member");
});

test("an archived member cannot keep a photo or be given consent", async () => {
    const id = await addMember(gymA);
    await setConsent(gymA, id, true);
    await setPhoto(id, photoPath(gymA, id));
    await assert.rejects(db.query("UPDATE public.members SET archived_at = now() WHERE id = $1", [id]), /members_archived_has_no_photo/);
    await db.query("UPDATE public.members SET archived_at = now(), photo_path = NULL, photo_status = 'none', photo_updated_at = now() WHERE id = $1", [id]);
    await assert.rejects(setConsent(gymA, id, false), /Member not found/);
});

test("consent sources stay tied to their purpose", async () => {
    const id = await addMember(gymA);
    await assert.rejects(db.query(
        "INSERT INTO public.member_consent_events (gym_id, member_id, channel, action, source) VALUES ($1, $2, 'photo', 'granted', 'csv_import')", [gymA, id]
    ));
    await assert.rejects(db.query(
        "INSERT INTO public.member_consent_events (gym_id, member_id, channel, action, source) VALUES ($1, $2, 'whatsapp', 'granted', 'desk')", [gymA, id]
    ));
});

test("photo consent history is append-only", async () => {
    const id = await addMember(gymA);
    await setConsent(gymA, id, true);
    await assert.rejects(db.query("DELETE FROM public.member_consent_events WHERE member_id = $1", [id]), /append-only/);
    await assert.rejects(db.query("UPDATE public.member_consent_events SET action = 'withdrawn' WHERE member_id = $1", [id]), /append-only/);
});

test("logged-in browser roles cannot write photo columns or call the consent function; they read only their gym", async () => {
    const id = await addMember(gymA);
    const idB = await addMember(gymB, "Aisha Khan");
    await setConsent(gymA, id, true);
    await setConsent(gymB, idB, true, "desk", ownerB);
    await asOwner(ownerA, async () => {
        await assert.rejects(db.query("UPDATE public.members SET photo_status = 'approved', photo_path = $2, photo_updated_at = now() WHERE id = $1", [id, photoPath(gymA, id)]), /managed by the GymPulse server/);
        await assert.rejects(db.query("UPDATE public.members SET photo_consent = false WHERE id = $1", [id]), /managed by the GymPulse server/);
        await assert.rejects(setConsent(gymA, id, false), /permission denied/);
        // Ordinary edits still work.
        await db.query("UPDATE public.members SET notes = 'Morning batch' WHERE id = $1", [id]);
        const events = (await db.query("SELECT DISTINCT gym_id FROM public.member_consent_events WHERE channel = 'photo'")).rows;
        assert.deepEqual(events.map((event) => event.gym_id), [gymA]);
        const members = (await db.query("SELECT id FROM public.members WHERE id = $1", [idB])).rows;
        assert.deepEqual(members, [], "gym B's member is invisible to gym A");
    });
});
