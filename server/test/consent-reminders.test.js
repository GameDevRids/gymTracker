import test from "node:test";
import assert from "node:assert/strict";
import { listExpiringMemberships } from "../services/membershipsService.js";
import { importMembers, validateImportRows } from "../../assets/js/modules/memberImport.js";

// The expiring renderer translates labels through i18n, which reads the saved language.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { reminderBlocker, renderExpiring } = await import("../../assets/js/modules/expiring.js");

const gymId = "00000000-0000-4000-8000-000000000099";
const membership = (id, member, endDate = "2026-11-09") => ({
    id, gym_id: gymId, member_id: member.id, plan_id: "p1", plan_name: "Monthly", duration_days: 30, price: 1800, total_fees: 1800,
    start_date: "2026-10-11", end_date: endDate, status: "assigned", created_at: "2026-10-11", members: member
});

function expiringClient(rows) {
    const calls = [];
    return {
        calls,
        from(table) {
            const call = { table, operations: [] };
            calls.push(call);
            const query = {};
            for (const method of ["select", "eq", "is", "order", "range"]) {
                query[method] = (...args) => { call.operations.push([method, ...args]); return query; };
            }
            query.then = (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject);
            return query;
        }
    };
}

test("the expiring list reports each member's WhatsApp consent, defaulting to none", async () => {
    const client = expiringClient([
        membership("m1", { id: "a", full_name: "Riya Shah", phone: "9876543210", whatsapp_opt_in: true }),
        membership("m2", { id: "b", full_name: "Dev Rao", phone: "9876543211", whatsapp_opt_in: false }),
        membership("m3", { id: "c", full_name: "Aisha Khan", phone: "9876543212" })
    ]);
    const rows = await listExpiringMemberships({ days: 7, gymId }, client, "2026-11-06");
    assert.deepEqual(rows.map((row) => [row.member.full_name, row.member.whatsapp_opt_in]), [
        ["Aisha Khan", false], ["Dev Rao", false], ["Riya Shah", true]
    ]);
    const select = client.calls[0].operations.find(([method]) => method === "select")[1];
    assert.match(select, /members!member_memberships_member_id_fkey!inner\([^)]*whatsapp_opt_in/);
});

test("members without consent are skipped by expiry reminders", () => {
    const rows = [
        { id: "m1", plan_name: "Monthly", end_date: "2026-11-09", days_left: 3, member: { id: "a", full_name: "Riya Shah", phone: "9876543210", whatsapp_opt_in: true } },
        { id: "m2", plan_name: "Monthly", end_date: "2026-11-10", days_left: 4, member: { id: "b", full_name: "Dev Rao", phone: "9876543211", whatsapp_opt_in: false } },
        { id: "m3", plan_name: "Monthly", end_date: "2026-11-11", days_left: 5, member: { id: "c", full_name: "Aisha Khan", phone: "9876543212" } },
        { id: "m4", plan_name: "Monthly", end_date: "2026-11-12", days_left: 6, member: { id: "d", full_name: "Kabir Mehta", phone: "12345", whatsapp_opt_in: true } }
    ];
    assert.deepEqual(rows.map((row) => reminderBlocker(row.member)), ["", "no-consent", "no-consent", "invalid-phone"]);

    const html = renderExpiring(rows, "ready", 7, "Hi {name}", new Set());
    const links = [...html.matchAll(/href="https:\/\/wa\.me\/91(\d+)/g)].map((match) => match[1]);
    assert.deepEqual(links, ["9876543210"], "only the consenting member gets a WhatsApp link");
    assert.equal((html.match(/No WhatsApp consent/g) || []).length, 2);
    assert.match(html, /data-total="1"/, "the reminder count includes only members who can be reminded");
});

test("CSV import records consent only for rows explicitly marked yes", async () => {
    const parsed = [
        { rowNumber: 2, data: { name: "Riya Shah", phone: "9876543210", whatsappoptin: "yes" } },
        { rowNumber: 3, data: { name: "Dev Rao", phone: "9876543211", whatsappoptin: "no" } },
        { rowNumber: 4, data: { name: "Aisha Khan", phone: "9876543212" } },
        { rowNumber: 5, data: { name: "Kabir Mehta", phone: "9876543213", whatsappoptin: "maybe" } }
    ];
    const { valid, invalid } = validateImportRows(parsed);
    assert.deepEqual(invalid.map((row) => [row.rowNumber, row.issues]), [[5, ["WhatsApp consent must be yes or no"]]]);

    const consents = [];
    const result = await importMembers(valid, {
        today: "2026-11-11",
        createMember: async (member) => ({ id: `id-${member.phone}` }),
        assignPlan: async () => ({}),
        recordConsent: async (...args) => { consents.push(args); }
    });
    assert.deepEqual(consents, [["id-9876543210", true, "csv_import"]]);
    assert.deepEqual(result.errors, []);
});

test("a failed consent recording during import is reported for that row, not silently dropped", async () => {
    const { valid } = validateImportRows([{ rowNumber: 2, data: { name: "Riya Shah", phone: "9876543210", whatsappconsent: "Y" } }]);
    const result = await importMembers(valid, {
        today: "2026-11-11",
        createMember: async () => ({ id: "x" }),
        assignPlan: async () => ({}),
        recordConsent: async () => { throw new Error("Network down."); }
    });
    assert.equal(result.imported, 1);
    assert.deepEqual(result.errors, [{ rowNumber: 2, message: "Member was created, but WhatsApp consent was not recorded: Network down. Record it from the member's profile." }]);
});
