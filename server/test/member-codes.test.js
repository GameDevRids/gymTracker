// Migrations 022 and 023 in real Postgres (PGlite): new members get short per-gym codes, existing
// members are untouched by 022, typed-in codes are kept, and the optional 023 shortens the old long
// codes (keeping them searchable).
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMigratedDatabase } from "./helpers/database.js";

const sql = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const owner = "00000000-0000-4000-8000-00000000000a";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
let db;
let phones = 0;
const add = async (gym, code, name) => (await db.query(
    "INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING member_code",
    [gym, code, name, `98000000${String(++phones).padStart(2, "0")}`])).rows[0].member_code;
const codesOf = async (gym) => (await db.query("SELECT full_name, member_code, previous_member_code FROM public.members WHERE gym_id = $1 ORDER BY created_at, full_name", [gym])).rows;

before(async () => {
    // The live project is at 021 with members that already have long codes.
    db = await createMigratedDatabase({ upTo: "021_add_plan_holds.sql" });
    await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${owner}', 'o@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'A', '${owner}'), ('${gymB}', 'B', '${owner}');`);
    await add(gymA, "GP-D99D8ECC34DB", "Old one");
    await add(gymA, "GP-0011AABBCCDD", "Old two");
    await add(gymB, "GP-AAAAAAAAAAAA", "Other gym old");
});

test("022 changes no existing member, and can be run twice", async () => {
    await db.exec(sql("022_add_short_member_codes.sql"));
    await db.exec(sql("022_add_short_member_codes.sql"));
    assert.deepEqual((await codesOf(gymA)).map((row) => [row.member_code, row.previous_member_code]), [["GP-D99D8ECC34DB", null], ["GP-0011AABBCCDD", null]]);
});

test("new members get GP-101, GP-102 … counted separately in each gym", async () => {
    assert.equal(await add(gymA, "GP-AAAABBBBCCCC", "New A1"), "GP-101", "the automatic long code is replaced");
    assert.equal(await add(gymA, null, "New A2"), "GP-102", "no code at all also gets one");
    assert.equal(await add(gymB, "GP-123456789ABC", "New B1"), "GP-101", "another gym counts on its own");
    assert.equal(await add(gymA, "GP-FFFFFFFFFFFF", "New A3"), "GP-103");
});

test("a code typed in on purpose is kept, and a taken number is skipped", async () => {
    assert.equal(await add(gymA, "MY-7", "Typed"), "MY-7");
    assert.equal(await add(gymA, "GP-104", "Took 104 by hand"), "GP-104");
    assert.equal(await add(gymA, null, "After the taken one"), "GP-105");
});

test("the import creates members with short codes too", async () => {
    await db.query("SELECT public.gympulse_import_members($1, $2::jsonb)", [gymA, JSON.stringify({ rows: [{ row: 2, full_name: "Imported Person", phone: "9822222222", notes: null, plan: null, start_date: null, end_date: null, amount_paid: null }] })]);
    const imported = (await db.query("SELECT member_code FROM public.members WHERE full_name = 'Imported Person'")).rows[0];
    assert.match(imported.member_code, /^GP-\d{3,}$/);
});

test("the counter table and functions are not reachable from the app's roles", async () => {
    const privilege = async (role, what) => (await db.query(what.replace("$ROLE", role))).rows[0].ok;
    for (const role of ["anon", "authenticated", "service_role"]) {
        assert.equal(await privilege(role, "SELECT has_table_privilege('$ROLE', 'public.gym_member_counters', 'select') AS ok"), false, role);
        assert.equal(await privilege(role, "SELECT has_function_privilege('$ROLE', 'public.gympulse_next_member_code(uuid)', 'execute') AS ok"), false, role);
    }
    assert.equal((await db.query("SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'gym_member_counters'")).rows[0].rls, true);
});

test("023 shortens the old long codes, oldest first, keeps the old code, and leaves typed codes alone", async () => {
    await db.exec(sql("023_shorten_existing_member_codes.sql"));
    const a = await codesOf(gymA);
    const oldOne = a.find((row) => row.full_name === "Old one");
    const oldTwo = a.find((row) => row.full_name === "Old two");
    assert.deepEqual([oldOne.previous_member_code, oldTwo.previous_member_code], ["GP-D99D8ECC34DB", "GP-0011AABBCCDD"]);
    assert.match(oldOne.member_code, /^GP-\d+$/);
    assert.ok(Number(oldOne.member_code.slice(3)) < Number(oldTwo.member_code.slice(3)), "the older member gets the lower number");
    assert.equal(a.find((row) => row.full_name === "Typed").member_code, "MY-7");
    assert.equal(new Set(a.map((row) => row.member_code)).size, a.length, "every code in the gym is still unique");
    const b = (await codesOf(gymB)).find((row) => row.full_name === "Other gym old");
    assert.deepEqual([b.member_code, b.previous_member_code], ["GP-102", "GP-AAAAAAAAAAAA"], "gym B counts on its own");
});

test("023 can be run again and changes nothing more", async () => {
    const before = await codesOf(gymA);
    await db.exec(sql("023_shorten_existing_member_codes.sql"));
    assert.deepEqual(await codesOf(gymA), before);
});
