import test from "node:test";
import assert from "node:assert/strict";
import { listExpiring } from "../services/memberStatusService.js";
import { fakeStatusDb, statusGym } from "./helpers/fakeStatusDb.js";
import { guessColumns, planImport, readImportRows } from "../../assets/js/modules/memberImport.js";

// The expiring renderer translates labels through i18n, which reads the saved language.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { reminderBlocker, renderExpiring } = await import("../../assets/js/modules/expiring.js");

test("the expiring list reports each member's WhatsApp consent, defaulting to none", async () => {
    const plan = (id, memberId) => ({ id, member_id: memberId, plan_name: "Monthly", grace_days: 3, start_date: "2026-10-11", end_date: "2026-11-09", created_at: "2026-10-11" });
    const db = fakeStatusDb({
        members: [
            { id: "a", full_name: "Riya Shah", phone: "9876543210", whatsapp_opt_in: true },
            { id: "b", full_name: "Dev Rao", phone: "9876543211", whatsapp_opt_in: false },
            { id: "c", full_name: "Aisha Khan", phone: "9876543212" }
        ],
        memberships: [plan("m1", "a"), plan("m2", "b"), plan("m3", "c")]
    });
    const rows = await listExpiring(statusGym, db, "2026-11-06");
    assert.deepEqual(rows.map((row) => [row.member.full_name, row.member.whatsapp_opt_in]), [
        ["Aisha Khan", false], ["Dev Rao", false], ["Riya Shah", true]
    ]);
});
test("members without consent are skipped by expiry reminders", () => {
    // All four are 3 days or fewer from the end, so the board offers each a reminder.
    const row = (id, end, daysLeft, member) => ({ id, plan_name: "Monthly", end_date: end, days_left: daysLeft, member_status: "expiring", remindable: true, member });
    const rows = [
        row("m1", "2026-11-09", 3, { id: "a", full_name: "Riya Shah", phone: "9876543210", whatsapp_opt_in: true }),
        row("m2", "2026-11-08", 2, { id: "b", full_name: "Dev Rao", phone: "9876543211", whatsapp_opt_in: false }),
        row("m3", "2026-11-07", 1, { id: "c", full_name: "Aisha Khan", phone: "9876543212" }),
        row("m4", "2026-11-06", 0, { id: "d", full_name: "Kabir Mehta", phone: "12345", whatsapp_opt_in: true })
    ];
    assert.deepEqual(rows.map((row) => reminderBlocker(row.member)), ["", "no-consent", "no-consent", "invalid-phone"]);

    const html = renderExpiring(rows, "ready", "Hi {name}", new Set());
    const links = [...html.matchAll(/href="https:\/\/wa\.me\/91(\d+)/g)].map((match) => match[1]);
    assert.deepEqual(links, ["9876543210"], "only the consenting member gets a WhatsApp link");
    assert.equal((html.match(/No WhatsApp consent/g) || []).length, 2);
    assert.match(html, /data-total="1"/, "the reminder count includes only members who can be reminded");
});

test("imported members never get WhatsApp consent, whatever the file says", () => {
    const text = (...values) => values.map((value) => ({ text: value }));
    const rows = readImportRows([
        text("Name", "Phone", "WhatsApp opt in"),
        text("Riya Shah", "9876543210", "yes")
    ], 0, guessColumns(text("Name", "Phone", "WhatsApp opt in")));
    const { payload } = planImport(rows);
    assert.equal(payload.rows.length, 1);
    assert.deepEqual(Object.keys(payload.rows[0]).sort(), ["amount_paid", "end_date", "full_name", "notes", "phone", "plan", "row", "start_date"]);
});
