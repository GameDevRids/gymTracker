// Runs migration 012 in real Postgres (PGlite): QR tokens and one check-in per member per IST day.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { applyMigration, createMigratedDatabase } from "./helpers/database.js";

const MIGRATION = "012_add_qr_checkin_attendance.sql";
const ownerA = "00000000-0000-4000-8000-00000000000a";
const ownerB = "00000000-0000-4000-8000-00000000000b";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
let db;
let existing;

async function addMember(gymId, name, phone) {
    const { rows } = await db.query(
        "INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING id, qr_token",
        [gymId, `GP-${phone}`, name, phone]
    );
    return rows[0];
}

const checkIn = (gymId, memberId, at, status = "active") => db.query(
    "INSERT INTO public.attendance (gym_id, member_id, checked_in_at, method, membership_status_at_check_in) VALUES ($1, $2, $3, 'qr', $4) RETURNING check_in_date::text AS day",
    [gymId, memberId, at, status]
).then(({ rows }) => rows[0].day);

before(async () => {
    db = await createMigratedDatabase({ upTo: "011_add_upi_and_receipts.sql" });
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${ownerA}', 'a@example.test'), ('${ownerB}', 'b@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'Gym A', '${ownerA}'), ('${gymB}', 'Gym B', '${ownerB}');
        INSERT INTO public.gym_users (gym_id, user_id) VALUES ('${gymA}', '${ownerA}'), ('${gymB}', '${ownerB}');
    `);
    // A member who existed before migration 012, so has no token yet.
    existing = (await db.query("INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING id", [gymA, "GP-OLD", "Riya Shah", "9876500301"])).rows[0];
    await applyMigration(db, MIGRATION);
});

test("existing and new members get a long, random, unique token that reveals nothing about them", async () => {
    const before = (await db.query("SELECT id, full_name, phone, qr_token FROM public.members WHERE id = $1", [existing.id])).rows[0];
    const fresh = await addMember(gymA, "Dev Rao", "9876500302");
    const other = await addMember(gymB, "Aisha Khan", "9876500303");
    for (const [token, member] of [[before.qr_token, before], [fresh.qr_token, { id: fresh.id, full_name: "Dev Rao", phone: "9876500302" }]]) {
        assert.match(token, /^[A-Za-z0-9_-]{22,}$/);
        assert.ok(token.length >= 22);
        for (const part of [member.id, member.id.replace(/-/g, ""), member.full_name, member.phone, "Riya", "Dev"]) {
            assert.equal(token.toLowerCase().includes(part.toLowerCase()), false, `token contains ${part}`);
        }
    }
    assert.equal(new Set([before.qr_token, fresh.qr_token, other.qr_token]).size, 3);
    await assert.rejects(db.query("UPDATE public.members SET qr_token = $1 WHERE id = $2", [fresh.qr_token, existing.id]), /members_qr_token_key/);
    await assert.rejects(db.query("UPDATE public.members SET qr_token = 'short' WHERE id = $1", [existing.id]), /members_qr_token_format/);
});

test("one check-in per member per IST day, split exactly at midnight IST", async () => {
    const member = await addMember(gymA, "Neha Joshi", "9876500304");
    // 23:59:59 IST on 12 Nov and 00:00:00 IST on 13 Nov.
    assert.equal(await checkIn(gymA, member.id, "2026-11-12T18:29:59Z"), "2026-11-12");
    assert.equal(await checkIn(gymA, member.id, "2026-11-12T18:30:00Z"), "2026-11-13");
    // 05:00 IST on 13 Nov is still the 13th: refused.
    await assert.rejects(checkIn(gymA, member.id, "2026-11-12T23:30:00Z"), /attendance_one_per_member_per_day/);
    // 00:30 UTC on 12 Nov is 06:00 IST on 12 Nov: also a repeat.
    await assert.rejects(checkIn(gymA, member.id, "2026-11-12T00:30:00Z"), /attendance_one_per_member_per_day/);
});

test("attendance keeps a member and gym together, and checks method and status", async () => {
    const memberB = (await db.query("SELECT id FROM public.members WHERE gym_id = $1 LIMIT 1", [gymB])).rows[0].id;
    await assert.rejects(checkIn(gymA, memberB, "2026-11-14T03:00:00Z"), /attendance_gym_member_fkey/);
    const member = await addMember(gymA, "Kabir Mehta", "9876500305");
    await assert.rejects(checkIn(gymA, member.id, "2026-11-14T03:00:00Z", "maybe"), /attendance_membership_status_valid/);
    await assert.rejects(db.query("INSERT INTO public.attendance (gym_id, member_id, method, membership_status_at_check_in) VALUES ($1, $2, 'face', 'active')", [gymA, member.id]), /attendance_method_valid/);
    assert.equal(await checkIn(gymA, member.id, "2026-11-14T03:00:00Z", "expired"), "2026-11-14");
});

test("gym A's owner reads only gym A's attendance and cannot write it directly", async () => {
    const memberB = await addMember(gymB, "Ira Chavan", "9876500306");
    await checkIn(gymB, memberB.id, "2026-11-15T03:00:00Z");
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${ownerA}', false);`);
    try {
        const gyms = (await db.query("SELECT DISTINCT gym_id FROM public.attendance")).rows.map((row) => row.gym_id);
        assert.deepEqual(gyms, [gymA]);
        await assert.rejects(checkIn(gymA, existing.id, "2026-11-16T03:00:00Z"), /permission denied/);
        // Another gym's token finds nothing.
        assert.deepEqual((await db.query("SELECT id FROM public.members WHERE qr_token = $1", [memberB.qr_token])).rows, []);
    } finally {
        await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);");
    }
});
