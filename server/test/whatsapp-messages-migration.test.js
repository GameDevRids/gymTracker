// Runs migration 010 in real Postgres (PGlite): the welcome log needs consent and stays per gym.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createMigratedDatabase } from "./helpers/database.js";

const ownerA = "00000000-0000-4000-8000-00000000000a";
const ownerB = "00000000-0000-4000-8000-00000000000b";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
let db;

async function addMember(gymId, name, phone, { consent = false } = {}) {
    const { rows } = await db.query(
        "INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING id",
        [gymId, `GP-${phone}`, name, phone]
    );
    if (consent) {
        await db.query("SELECT * FROM public.gympulse_set_member_whatsapp_consent($1, $2, true, 'staff_form', NULL)", [gymId, rows[0].id]);
    }
    return rows[0].id;
}

const logWelcome = (gymId, memberId) => db.query(
    "INSERT INTO public.whatsapp_messages (gym_id, member_id, reminder_type, language, body) VALUES ($1, $2, 'welcome', 'en', 'Hi') RETURNING *",
    [gymId, memberId]
);

before(async () => {
    db = await createMigratedDatabase();
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${ownerA}', 'a@example.test'), ('${ownerB}', 'b@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'Gym A', '${ownerA}'), ('${gymB}', 'Gym B', '${ownerB}');
        INSERT INTO public.gym_users (gym_id, user_id) VALUES ('${gymA}', '${ownerA}'), ('${gymB}', '${ownerB}');
    `);
});

test("a welcome is logged as sent over wa.me for a member who consented", async () => {
    const id = await addMember(gymA, "Riya Shah", "9876500101", { consent: true });
    const { rows } = await logWelcome(gymA, id);
    assert.equal(rows[0].status, "sent");
    assert.equal(rows[0].channel, "wa_me");
    assert.equal(rows[0].reminder_type, "welcome");
});

test("the database refuses to log a message for a member without consent", async () => {
    const id = await addMember(gymA, "Dev Rao", "9876500102");
    await assert.rejects(logWelcome(gymA, id), /not agreed to receive WhatsApp/);
    const withdrawn = await addMember(gymA, "Aisha Khan", "9876500103", { consent: true });
    await db.query("SELECT * FROM public.gympulse_set_member_whatsapp_consent($1, $2, false, 'member_reply_stop', NULL)", [gymA, withdrawn]);
    await assert.rejects(logWelcome(gymA, withdrawn), /not agreed to receive WhatsApp/);
});

test("a message cannot be logged under a different gym than the member's", async () => {
    const memberB = await addMember(gymB, "Gym B Member", "9876500104", { consent: true });
    await assert.rejects(logWelcome(gymA, memberB), /not agreed|foreign key/);
});

test("gym A's owner reads only gym A's welcome log and templates, and cannot write either", async () => {
    const memberA = await addMember(gymA, "Owner A Member", "9876500105", { consent: true });
    const memberB = await addMember(gymB, "Owner B Member", "9876500106", { consent: true });
    await logWelcome(gymA, memberA);
    await logWelcome(gymB, memberB);
    await db.exec(`
        INSERT INTO public.gym_message_templates (gym_id, template_key, language, body) VALUES
            ('${gymA}', 'welcome', 'hi', 'नमस्ते {name}'), ('${gymB}', 'welcome', 'hi', 'B {name}');
    `);

    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${ownerA}', false);`);
    try {
        const gyms = (await db.query("SELECT DISTINCT gym_id FROM public.whatsapp_messages")).rows.map((row) => row.gym_id);
        assert.deepEqual(gyms, [gymA]);
        assert.deepEqual((await db.query("SELECT * FROM public.whatsapp_messages WHERE member_id = $1", [memberB])).rows, []);
        assert.deepEqual((await db.query("SELECT body FROM public.gym_message_templates")).rows, [{ body: "नमस्ते {name}" }]);
        await assert.rejects(logWelcome(gymA, memberA), /permission denied/);
        await assert.rejects(db.query(`UPDATE public.gym_message_templates SET body = 'x' WHERE gym_id = '${gymA}'`), /permission denied/);
    } finally {
        await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);");
    }
});

test("templates are one per gym and language, with a bounded, non-empty body", async () => {
    await assert.rejects(db.query(`INSERT INTO public.gym_message_templates (gym_id, template_key, language, body) VALUES ('${gymA}', 'welcome', 'hi', 'again')`), /duplicate key/);
    await assert.rejects(db.query(`INSERT INTO public.gym_message_templates (gym_id, template_key, language, body) VALUES ('${gymA}', 'welcome', 'ta', 'x')`), /language_valid/);
    await assert.rejects(db.query(`INSERT INTO public.gym_message_templates (gym_id, template_key, language, body) VALUES ('${gymA}', 'welcome', 'mr', '   ')`), /body_length/);
});
