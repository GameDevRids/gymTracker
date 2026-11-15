import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { inflateRawSync } from "node:zlib";
import { buildGymWorkbook } from "../services/exportService.js";
import { readSpreadsheet } from "../../assets/js/spreadsheet.js";
import { scrubEvent } from "../config/monitoring.js";
import { createClientErrorsRouter } from "../routes/clientErrors.js";

const gymId = "00000000-0000-4000-8000-0000000000aa";
const otherGym = "00000000-0000-4000-8000-0000000000bb";
const memberId = "00000000-0000-4000-8000-000000000011";

// A fake Supabase client: each table's rows, filtered by gym_id and paged by range().
function fakeDb(tables, { failTable } = {}) {
    const queries = [];
    return {
        queries,
        from(table) {
            const query = { table, filters: {}, range: null };
            queries.push(query);
            const builder = {
                select() { return builder; },
                eq(column, value) { query.filters[column] = value; return builder; },
                order() { return builder; },
                async range(from, to) {
                    if (table === failTable) return { data: null, error: { code: "42P01" } };
                    const rows = (tables[table] || []).filter((row) => row.gym_id === query.filters.gym_id);
                    return { data: rows.slice(from, to + 1), error: null };
                }
            };
            return builder;
        }
    };
}

const tables = {
    members: [
        { gym_id: gymId, id: memberId, member_code: "GP-0001", full_name: "Asha Patil", phone: "9876543210", email: "", status: "active", whatsapp_opt_in: true, created_at: "2026-10-01T05:00:00Z", archived_at: null },
        { gym_id: otherGym, id: "x", member_code: "OTHER-1", full_name: "Other Gym Member", phone: "9000000000", status: "active", created_at: "2026-10-01T05:00:00Z" }
    ],
    member_memberships: [
        { gym_id: gymId, id: "m1", member_id: memberId, plan_name: "Monthly", duration_days: 30, price: 1500, total_fees: 1500, start_date: "2026-11-01", end_date: "2026-11-30", status: "active", created_at: "2026-11-01T05:00:00Z" }
    ],
    payments: [
        { gym_id: gymId, id: "p1", member_id: memberId, receipt_number: "R-1", amount: 1000, method: "upi", paid_on: "2026-11-01", upi_reference: "123456789012", note: "", created_at: "2026-11-01T05:00:00Z" }
    ],
    attendance: [
        { gym_id: gymId, id: "a1", member_id: memberId, checked_in_at: "2026-11-10T01:30:00Z", check_in_date: "2026-11-10", method: "manual", membership_status_at_check_in: "active" }
    ]
};

const inflateRaw = async (bytes) => new Uint8Array(inflateRawSync(bytes));
const text = (cell) => (cell && typeof cell === "object" ? cell.text ?? cell.value ?? "" : cell);

test("the Excel export has one sheet per kind of data, only for the signed-in gym", async () => {
    const db = fakeDb(tables);
    const bytes = await buildGymWorkbook(gymId, db, "2026-11-16");
    assert.ok(db.queries.every((query) => query.filters.gym_id === gymId), "every read is limited to the gym");

    const { sheets } = await readSpreadsheet("export.xlsx", bytes, { inflateRaw });
    assert.deepEqual(sheets.map((sheet) => sheet.name), ["Members", "Memberships", "Payments", "Attendance"]);
    const members = sheets[0].rows.map((row) => row.map(text));
    assert.equal(members.length, 2, "header and this gym's one member");
    assert.deepEqual(members[1].slice(0, 3), ["GP-0001", "Asha Patil", "9876543210"]);
    const header = members[0];
    const row = Object.fromEntries(header.map((name, index) => [name, members[1][index]]));
    assert.equal(row["Plan status"], "Active");
    assert.equal(String(row["Balance (₹)"]), "500");
    assert.equal(row["WhatsApp consent"], "Yes");
    assert.ok(!JSON.stringify(sheets).includes("Other Gym Member"));
    assert.equal(sheets[2].rows.length, 2);
    assert.equal(sheets[3].rows.length, 2);
});

test("the export asks for the latest migrations when a table is missing", async () => {
    await assert.rejects(buildGymWorkbook(gymId, fakeDb(tables, { failTable: "attendance" }), "2026-11-16"),
        { status: 503, message: /latest migrations/ });
    await assert.rejects(buildGymWorkbook("", fakeDb(tables)), { status: 403 });
});

test("Sentry events lose the user, headers, body, query and personal text before sending", () => {
    const event = scrubEvent({
        user: { email: "owner@example.test", ip_address: "203.0.113.5" },
        request: {
            method: "POST",
            url: "https://app.example/api/members/00000000-0000-4000-8000-000000000011?phone=9876543210",
            headers: { authorization: "Bearer eyJabc.def.ghi", cookie: "x" },
            data: { phone: "9876543210" }
        },
        message: 'Member "Asha Patil" with 9876543210 failed',
        exception: { values: [{ type: "Error", value: "owner@example.test failed", stacktrace: { frames: [{ filename: "a.js", vars: { phone: "9876543210" } }] } }] },
        breadcrumbs: [{ category: "fetch", message: "GET ?phone=eq.9876543210", data: { method: "GET", url: "https://x.supabase.co/rest/v1/members?phone=eq.9876543210", status_code: 200 } }],
        extra: { stack: "at call(9876543210)" }
    });
    assert.equal(event.user, undefined);
    assert.deepEqual(event.request, { method: "POST", url: "/api/members/:id" });
    assert.equal(event.message, "Member [text] with [phone] failed");
    assert.equal(event.exception.values[0].value, "[email] failed");
    assert.deepEqual(event.exception.values[0].stacktrace.frames, [{ filename: "a.js" }]);
    assert.deepEqual(event.breadcrumbs[0].data, { method: "GET", url: "/rest/v1/members", status_code: 200 });
    assert.doesNotMatch(JSON.stringify(event), /9876543210|owner@example|Asha|eyJ/);
});

test("POST /api/client-errors passes valid reports on, ignores bad ones, and always answers 204", async () => {
    const captured = [];
    const app = express();
    app.use(express.json());
    app.use("/api/client-errors", createClientErrorsRouter({ capture: (report) => captured.push(report) }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/client-errors`;
    const send = (body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
        const good = await send({ message: "x is undefined", source: "/assets/js/main.js:1:2", view: "members", version: "1.0.0-beta.1" });
        assert.equal(good.status, 204);
        assert.equal((await send({ message: "y", extra: "not allowed" })).status, 204);
        assert.equal((await send({ message: "z".repeat(501) })).status, 204);
        assert.equal((await send({ message: "v", view: "<script>" })).status, 204);
        assert.deepEqual(captured, [{ message: "x is undefined", source: "/assets/js/main.js:1:2", view: "members", version: "1.0.0-beta.1" }]);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
