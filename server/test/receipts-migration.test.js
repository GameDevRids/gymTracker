// Runs migration 011 in real Postgres (PGlite): receipt numbers, UPI references, gym settings and RLS.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { applyMigration, createMigratedDatabase } from "./helpers/database.js";

const MIGRATION = "011_add_upi_and_receipts.sql";
const ownerA = "00000000-0000-4000-8000-00000000000a";
const ownerB = "00000000-0000-4000-8000-00000000000b";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
let db;
let memberA;
let memberB;

async function addMember(gymId, name, phone) {
    const { rows } = await db.query(
        "INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING id",
        [gymId, `GP-${phone}`, name, phone]
    );
    return rows[0].id;
}

const pay = (gymId, memberId, { amount = 500, method = "upi", utr = null, receipt = null } = {}) => db.query(
    "INSERT INTO public.payments (gym_id, member_id, amount, method, upi_reference, receipt_number) VALUES ($1, $2, $3, $4, $5, $6) RETURNING receipt_number",
    [gymId, memberId, amount, method, utr, receipt]
).then(({ rows }) => rows[0].receipt_number);

const receipts = async (gymId) => (await db.query(
    "SELECT receipt_number FROM public.payments WHERE gym_id = $1 ORDER BY receipt_number", [gymId]
)).rows.map((row) => row.receipt_number);

before(async () => {
    db = await createMigratedDatabase({ upTo: "010_create_whatsapp_messages_and_templates.sql" });
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${ownerA}', 'a@example.test'), ('${ownerB}', 'b@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'Gym A', '${ownerA}'), ('${gymB}', 'Gym B', '${ownerB}');
        INSERT INTO public.gym_users (gym_id, user_id) VALUES ('${gymA}', '${ownerA}'), ('${gymB}', '${ownerB}');
    `);
    memberA = await addMember(gymA, "Riya Shah", "9876500201");
    memberB = await addMember(gymB, "Dev Rao", "9876500202");
    // Payments recorded before migration 011, oldest first.
    await db.query(`INSERT INTO public.payments (gym_id, member_id, amount, method, created_at) VALUES
        ($1, $2, 100, 'cash', now() - interval '3 days'), ($1, $2, 200, 'upi', now() - interval '2 days'),
        ($3, $4, 300, 'card', now() - interval '1 day')`, [gymA, memberA, gymB, memberB]);
    await applyMigration(db, MIGRATION);
});

test("existing payments are numbered per gym, oldest first", async () => {
    const { rows } = await db.query("SELECT amount::int AS amount, receipt_number FROM public.payments WHERE gym_id = $1 ORDER BY created_at", [gymA]);
    assert.deepEqual(rows, [{ amount: 100, receipt_number: "R-000001" }, { amount: 200, receipt_number: "R-000002" }]);
    assert.deepEqual(await receipts(gymB), ["R-000001"]);
});

test("new receipt numbers continue per gym, in order, without clashing between gyms", async () => {
    assert.equal(await pay(gymA, memberA), "R-000003");
    assert.equal(await pay(gymB, memberB), "R-000002");
    assert.equal(await pay(gymA, memberA), "R-000004");
    assert.equal(await pay(gymB, memberB), "R-000003");
});

test("two quick saves get two different, consecutive numbers", async () => {
    const numbers = await Promise.all([pay(gymA, memberA), pay(gymA, memberA)]);
    assert.deepEqual([...numbers].sort(), ["R-000005", "R-000006"]);
});

test("a receipt number sent by the client is ignored", async () => {
    assert.equal(await pay(gymA, memberA, { receipt: "R-999999" }), "R-000007");
});

test("the same UTR is rejected within a gym but allowed in another gym, and a rejected save leaves no gap", async () => {
    assert.equal(await pay(gymA, memberA, { utr: "123456789012" }), "R-000008");
    await assert.rejects(pay(gymA, memberA, { utr: "123456789012" }), /payments_gym_upi_reference_key/);
    assert.equal(await pay(gymB, memberB, { utr: "123456789012" }), "R-000004");
    // The failed save rolled back its counter increment.
    assert.equal(await pay(gymA, memberA), "R-000009");
    const all = await receipts(gymA);
    assert.deepEqual(all, Array.from({ length: 9 }, (_, index) => `R-${String(index + 1).padStart(6, "0")}`));
});

test("a UTR must be 12 digits and only on UPI payments; amounts must be positive", async () => {
    await assert.rejects(pay(gymA, memberA, { utr: "12345" }), /payments_upi_reference_format/);
    await assert.rejects(pay(gymA, memberA, { method: "cash", utr: "999999999999" }), /payments_upi_reference_needs_upi/);
    await assert.rejects(pay(gymA, memberA, { amount: 0 }), /payments_amount_positive/);
    await assert.rejects(pay(gymA, memberA, { amount: -10 }), /payments_amount_positive/);
    assert.equal(await pay(gymA, memberA), "R-000010", "none of the rejected saves used a number");
});

test("receipt numbers cannot be changed and payments cannot be deleted", async () => {
    await assert.rejects(db.query("UPDATE public.payments SET receipt_number = 'R-000999' WHERE gym_id = $1", [gymA]), /cannot be changed/);
    await assert.rejects(db.query("UPDATE public.payments SET gym_id = $1 WHERE gym_id = $2", [gymB, gymA]), /cannot be changed/);
    await assert.rejects(db.query("DELETE FROM public.payments WHERE gym_id = $1", [gymA]), /cannot be deleted/);
    await db.query("UPDATE public.payments SET note = 'checked' WHERE gym_id = $1", [gymA]);
    assert.equal((await receipts(gymA)).length, 10);
});

test("numbers past 999999 keep all their digits", async () => {
    const { rows } = await db.query("SELECT public.gympulse_format_receipt_number(123) AS a, public.gympulse_format_receipt_number(1234567) AS b");
    assert.deepEqual(rows[0], { a: "R-000123", b: "R-1234567" });
});

test("gym settings check the UPI ID format", async () => {
    await db.query("INSERT INTO public.gym_settings (gym_id, upi_id, upi_payee_name) VALUES ($1, 'powergym@okicici', 'Power Gym')", [gymA]);
    await assert.rejects(db.query("INSERT INTO public.gym_settings (gym_id, upi_id) VALUES ($1, 'power gym@okicici')", [gymB]), /gym_settings_upi_id_format/);
    await db.query("INSERT INTO public.gym_settings (gym_id, upi_id) VALUES ($1, 'gymb@ybl')", [gymB]);
});

test("gym A's owner reads only gym A's payments and settings, and cannot touch counters or the reset", async () => {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${ownerA}', false);`);
    try {
        const gyms = (await db.query("SELECT DISTINCT gym_id FROM public.payments")).rows.map((row) => row.gym_id);
        assert.deepEqual(gyms, [gymA]);
        assert.deepEqual((await db.query("SELECT * FROM public.payments WHERE member_id = $1", [memberB])).rows, []);
        assert.deepEqual((await db.query("SELECT upi_id FROM public.gym_settings")).rows, [{ upi_id: "powergym@okicici" }]);
        await assert.rejects(db.query("SELECT * FROM public.gym_receipt_counters"), /permission denied/);
        await assert.rejects(db.query("SELECT public.gympulse_reset_demo_payments($1)", [gymA]), /permission denied/);
        await assert.rejects(db.query("UPDATE public.gym_settings SET upi_id = 'x@y' WHERE gym_id = $1", [gymA]), /permission denied/);
    } finally {
        await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);");
    }
});

test("the demo reset empties one gym's payments and restarts its numbers", async () => {
    await db.query("SELECT public.gympulse_reset_demo_payments($1)", [gymB]);
    assert.deepEqual(await receipts(gymB), []);
    assert.equal(await pay(gymB, memberB), "R-000001");
    assert.equal((await receipts(gymA)).length, 10, "other gyms are untouched");
    await assert.rejects(db.query("DELETE FROM public.payments WHERE gym_id = $1", [gymB]), /cannot be deleted/, "deletes are blocked again afterwards");
});
