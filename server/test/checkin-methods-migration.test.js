// Runs migration 013 in real Postgres (PGlite): one check-in method per gym, poster tokens,
// linked phones (hash only, own gym only) and the renamed attendance methods.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { applyMigration, createMigratedDatabase } from "./helpers/database.js";

const MIGRATION = "013_add_checkin_methods_and_member_devices.sql";
const ownerA = "00000000-0000-4000-8000-00000000000a";
const ownerB = "00000000-0000-4000-8000-00000000000b";
const ownerC = "00000000-0000-4000-8000-00000000000c";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
const hash = (character) => character.repeat(64);
let db;
let memberA;
let memberB;
let oldVisit;

async function addMember(gymId, name, phone) {
    const { rows } = await db.query(
        "INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING id, phone_last10, phone_last4",
        [gymId, `GP-${phone.replace(/\D/g, "")}`, name, phone]
    );
    return rows[0];
}

before(async () => {
    db = await createMigratedDatabase({ upTo: "012_add_qr_checkin_attendance.sql" });
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${ownerA}', 'a@example.test'), ('${ownerB}', 'b@example.test'), ('${ownerC}', 'c@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'Gym A', '${ownerA}'), ('${gymB}', 'Gym B', '${ownerB}');
        INSERT INTO public.gym_users (gym_id, user_id) VALUES ('${gymA}', '${ownerA}'), ('${gymB}', '${ownerB}');
    `);
    // Gym A already scans member QR cards; gym B has never used check-in.
    memberA = (await db.query("INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES ($1, 'GP-1', 'Riya Shah', '9876543210') RETURNING id", [gymA])).rows[0];
    memberB = (await db.query("INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES ($1, 'GP-2', 'Aisha Khan', '9876543212') RETURNING id", [gymB])).rows[0];
    oldVisit = (await db.query("INSERT INTO public.attendance (gym_id, member_id, checked_in_at, method, membership_status_at_check_in) VALUES ($1, $2, '2026-11-10T03:00:00Z', 'qr', 'active') RETURNING id", [gymA, memberA.id])).rows[0];
    await applyMigration(db, MIGRATION);
    // Running it again changes nothing.
    await applyMigration(db, MIGRATION);
});

test("gyms already scanning member QR cards keep that method; the others and new gyms get the poster", async () => {
    const methods = Object.fromEntries((await db.query("SELECT id, checkin_method FROM public.gyms")).rows.map((row) => [row.id, row.checkin_method]));
    assert.deepEqual(methods, { [gymA]: "member_qr", [gymB]: "entrance_poster" });
    const fresh = (await db.query("INSERT INTO public.gyms (name, owner_user_id) VALUES ('Gym C', $1) RETURNING *", [ownerC])).rows[0];
    assert.deepEqual(
        [fresh.checkin_method, fresh.expired_checkin_policy, fresh.expiry_grace_days, fresh.entrance_require_location, fresh.location_radius_m, fresh.latitude],
        ["entrance_poster", "warn", 0, false, 150, null]
    );
    const tokens = (await db.query("SELECT entrance_token FROM public.gyms")).rows.map((row) => row.entrance_token);
    for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(new Set(tokens).size, 3);
    await assert.rejects(db.query("UPDATE public.gyms SET entrance_token = $1 WHERE id = $2", [tokens[0], gymB]), /gyms_entrance_token_key/);
});

test("gym check-in settings are constrained", async () => {
    const update = (values) => db.query(`UPDATE public.gyms SET ${values} WHERE id = $1`, [gymB]);
    await assert.rejects(update("checkin_method = 'kiosk'"), /gyms_checkin_method_valid/);
    await assert.rejects(update("expired_checkin_policy = 'ignore'"), /gyms_expired_checkin_policy_valid/);
    await assert.rejects(update("expiry_grace_days = 61"), /gyms_expiry_grace_days_range/);
    await assert.rejects(update("location_radius_m = 5"), /gyms_location_radius_range/);
    await assert.rejects(update("latitude = 18.5"), /gyms_location_valid/);
    await assert.rejects(update("entrance_require_location = true"), /gyms_location_check_needs_point/);
    await assert.rejects(update("entrance_token = 'short'"), /gyms_entrance_token_format/);
    await update("latitude = 18.52, longitude = 73.85, entrance_require_location = true, expired_checkin_policy = 'block', expiry_grace_days = 3");
});

test("past check-ins are kept with the new method names, and methods are checked", async () => {
    const row = (await db.query("SELECT method, check_in_date::text AS day FROM public.attendance WHERE id = $1", [oldVisit.id])).rows[0];
    assert.deepEqual(row, { method: "member_qr", day: "2026-11-10" });
    const insert = (method, status, deviceId = null, at = "2026-11-11T03:00:00Z") => db.query(
        "INSERT INTO public.attendance (gym_id, member_id, checked_in_at, method, membership_status_at_check_in, member_device_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [gymA, memberA.id, at, method, status, deviceId]
    );
    await assert.rejects(insert("qr", "active"), /attendance_method_valid/);
    await assert.rejects(insert("manual", "blocked"), /attendance_membership_status_valid/);
    await assert.rejects(insert("entrance_poster", "active"), /attendance_device_matches_method/, "a poster check-in names the phone");
    await insert("manual", "grace");
    await insert("member_qr", "upcoming", null, "2026-11-12T03:00:00Z");
});

test("phones are linked per member with a hash only, and only to a member of the same gym", async () => {
    const link = (gymId, memberId, secretHash, status = "pending", extra = "") => db.query(
        `INSERT INTO public.member_devices (gym_id, member_id, device_secret_hash, status${extra ? ", approved_at" : ""}) VALUES ($1, $2, $3, $4${extra ? ", now()" : ""}) RETURNING id`,
        [gymId, memberId, secretHash, status]
    );
    await assert.rejects(link(gymA, memberB.id, hash("a")), /member_devices_gym_member_fkey/);
    await assert.rejects(link(gymA, memberA.id, "secret-in-plain-text"), /member_devices_hash_format/);
    await assert.rejects(link(gymA, memberA.id, hash("b"), "approved"), /member_devices_approved_has_time/);
    await assert.rejects(link(gymA, memberA.id, hash("b"), "trusted"), /member_devices_status_valid/);
    const approved = (await link(gymA, memberA.id, hash("c"), "approved", "approved")).rows[0];
    await assert.rejects(link(gymA, memberA.id, hash("c")), /member_devices_one_per_member_phone/);
    // A poster check-in from that phone, in the same gym only.
    await db.query("INSERT INTO public.attendance (gym_id, member_id, checked_in_at, method, membership_status_at_check_in, member_device_id) VALUES ($1, $2, '2026-11-13T03:00:00Z', 'entrance_poster', 'active', $3)", [gymA, memberA.id, approved.id]);
    await assert.rejects(
        db.query("INSERT INTO public.attendance (gym_id, member_id, checked_in_at, method, membership_status_at_check_in, member_device_id) VALUES ($1, $2, '2026-11-13T03:00:00Z', 'entrance_poster', 'active', $3)", [gymB, memberB.id, approved.id]),
        /attendance_member_device_fkey/
    );
    await link(gymB, memberB.id, hash("d"));
});

test("phone digits are kept for lookups, whatever the stored format", async () => {
    const member = await addMember(gymB, "Kabir Mehta", "+91 91234-03210");
    assert.deepEqual([member.phone_last10, member.phone_last4], ["9123403210", "3210"]);
});

test("gym A's owner reads only gym A's linked phones, never the secret hash, and cannot write them", async () => {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${ownerA}', false);`);
    try {
        const rows = (await db.query("SELECT gym_id, status FROM public.member_devices")).rows;
        assert.deepEqual(rows.map((row) => row.gym_id), [gymA]);
        await assert.rejects(db.query("SELECT device_secret_hash FROM public.member_devices"), /permission denied/);
        await assert.rejects(db.query("UPDATE public.member_devices SET status = 'approved'"), /permission denied/);
        await assert.rejects(db.query("UPDATE public.gyms SET checkin_method = 'member_qr'"), /permission denied/);
        const own = (await db.query("SELECT checkin_method FROM public.gyms")).rows;
        assert.deepEqual(own, [{ checkin_method: "member_qr" }], "own gym only");
    } finally {
        await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);");
    }
});
