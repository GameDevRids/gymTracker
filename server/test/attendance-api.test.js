import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
    importAttendance,
    listAttendance,
    manualCheckIn,
    newQrToken,
    reissueQrToken,
    scanCheckIn
} from "../services/attendanceService.js";
import { createScanRateLimit, validateAttendanceQuery, validateScan } from "../middleware/validateAttendance.js";
import { CHECKIN_PREFIX, daysLeft, indiaDate, memberQrText, parseCheckinQr } from "../../assets/js/checkin.js";

const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
const owner = "00000000-0000-4000-8000-00000000000a";
const ids = { riya: "00000000-0000-4000-8000-000000000001", dev: "00000000-0000-4000-8000-000000000002", aisha: "00000000-0000-4000-8000-000000000003", neha: "00000000-0000-4000-8000-000000000004" };
const tokens = { riya: newQrToken(), dev: newQrToken(), aisha: newQrToken(), neha: newQrToken() };
// 07:42 IST on 12 Nov 2026.
const morning = new Date("2026-11-12T02:12:00Z");

/** A small in-memory stand-in for the Supabase client, with the one-per-IST-day rule. */
function fakeDb() {
    const tables = {
        members: [
            { id: ids.riya, gym_id: gymA, full_name: "Riya Shah", member_code: "GP-1", phone: "9876543210", whatsapp_opt_in: true, qr_token: tokens.riya, archived_at: null },
            { id: ids.dev, gym_id: gymA, full_name: "Dev Rao", member_code: "GP-2", phone: "9876543211", whatsapp_opt_in: false, qr_token: tokens.dev, archived_at: null },
            { id: ids.neha, gym_id: gymA, full_name: "Neha Joshi", member_code: "GP-4", phone: "9876543213", whatsapp_opt_in: false, qr_token: tokens.neha, archived_at: null },
            { id: ids.aisha, gym_id: gymB, full_name: "Aisha Khan", member_code: "GP-3", phone: "9876543212", whatsapp_opt_in: true, qr_token: tokens.aisha, archived_at: null }
        ],
        member_memberships: [
            { id: "ms-riya", gym_id: gymA, member_id: ids.riya, plan_name: "Monthly", price: 1100, start_date: "2026-11-01", end_date: "2026-11-30", status: "assigned", created_at: "2026-11-01" },
            { id: "ms-dev", gym_id: gymA, member_id: ids.dev, plan_name: "Monthly", price: 1100, start_date: "2026-10-01", end_date: "2026-11-09", status: "assigned", created_at: "2026-10-01" },
            { id: "ms-aisha", gym_id: gymB, member_id: ids.aisha, plan_name: "Annual", price: 9000, start_date: "2026-01-01", end_date: "2026-12-31", status: "assigned", created_at: "2026-01-01" }
        ],
        attendance: []
    };
    const calls = [];
    const withDay = (row) => ({ ...row, check_in_date: indiaDate(new Date(row.checked_in_at)) });
    const duplicate = (row) => tables.attendance.some((saved) => saved.gym_id === row.gym_id && saved.member_id === row.member_id && saved.check_in_date === row.check_in_date);
    return {
        tables,
        calls,
        from(table) {
            const op = { table, filters: [], action: "select", payload: null };
            calls.push(op);
            const query = {};
            query.select = () => query;
            for (const method of ["eq", "is", "in", "gte", "lte"]) query[method] = (field, value) => { op.filters.push([method, field, value]); return query; };
            query.order = () => query;
            query.range = () => query;
            query.insert = (row) => { op.action = "insert"; op.payload = row; return query; };
            query.update = (row) => { op.action = "update"; op.payload = row; return query; };
            query.upsert = (rows) => { op.action = "upsert"; op.payload = rows; return query; };
            const matches = (row) => op.filters.every(([method, field, value]) => (
                method === "eq" ? row[field] === value
                    : method === "is" ? (row[field] ?? null) === value
                        : method === "in" ? value.includes(row[field])
                            : method === "gte" ? row[field] >= value
                                : row[field] <= value));
            const run = () => {
                const list = tables[table];
                if (op.action === "insert") {
                    const row = withDay(op.payload);
                    if (duplicate(row)) return { data: null, error: { code: "23505" } };
                    const saved = { id: `att-${list.length + 1}`, ...row };
                    list.push(saved);
                    return { data: [saved], error: null };
                }
                if (op.action === "upsert") {
                    const inserted = [];
                    for (const raw of op.payload) {
                        const row = withDay(raw);
                        if (duplicate(row)) continue;
                        const saved = { id: `att-${list.length + 1}`, ...row };
                        list.push(saved);
                        inserted.push(saved);
                    }
                    return { data: inserted, error: null };
                }
                if (op.action === "update") {
                    const hits = list.filter(matches);
                    hits.forEach((row) => Object.assign(row, op.payload));
                    return { data: hits, error: null };
                }
                return { data: list.filter(matches), error: null };
            };
            query.single = () => { const result = run(); return Promise.resolve(result.error ? result : { data: result.data[0], error: null }); };
            query.maybeSingle = () => { const result = run(); return Promise.resolve({ data: result.data?.[0] || null, error: result.error }); };
            query.then = (resolve, reject) => Promise.resolve(run()).then(resolve, reject);
            return query;
        }
    };
}

// ---------- The QR text ----------

test("a member QR is the prefix plus the token, and anything else is not recognised", () => {
    const token = newQrToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(token, newQrToken());
    assert.equal(memberQrText(token), `${CHECKIN_PREFIX}${token}`);
    assert.equal(parseCheckinQr(` ${CHECKIN_PREFIX}${token} `), token);
    for (const text of [token, "https://example.com", `${CHECKIN_PREFIX}short`, `${CHECKIN_PREFIX}${token}!`, "upi://pay?pa=x@y", "", null]) {
        assert.equal(parseCheckinQr(text), null, String(text));
    }
    assert.throws(() => memberQrText(""), /no check-in QR/);
    assert.equal(daysLeft("2026-11-30", "2026-11-12"), 18);
    assert.equal(daysLeft("2026-11-09", "2026-11-12"), -3);
});

// ---------- Scanning ----------

test("a scan checks in the member of this gym, with plan and days left", async () => {
    const db = fakeDb();
    const result = await scanCheckIn(tokens.riya, gymA, owner, db, morning);
    assert.equal(result.result, "checked_in");
    assert.equal(result.member.full_name, "Riya Shah");
    assert.deepEqual([result.membership.plan_name, result.membership.end_date, result.membership.days_left], ["Monthly", "2026-11-30", 18]);
    assert.deepEqual(db.tables.attendance.map((row) => [row.member_id, row.method, row.membership_status_at_check_in, row.check_in_date, row.recorded_by]),
        [[ids.riya, "qr", "active", "2026-11-12", owner]]);
    const lookup = db.calls.find((call) => call.table === "members");
    assert.ok(lookup.filters.some(([method, field, value]) => method === "eq" && field === "gym_id" && value === gymA), "token lookup is limited to the gym");
});

test("a second scan the same day reports the first check-in time and records nothing", async () => {
    const db = fakeDb();
    await scanCheckIn(tokens.riya, gymA, owner, db, morning);
    const again = await scanCheckIn(tokens.riya, gymA, owner, db, new Date("2026-11-12T12:30:00Z"));
    assert.equal(again.result, "already_checked_in");
    assert.equal(again.attendance.checked_in_at, morning.toISOString());
    assert.equal(db.tables.attendance.length, 1);
});

test("a token from another gym, an unknown token and a malformed one all return not_found", async () => {
    const db = fakeDb();
    for (const token of [tokens.aisha, newQrToken(), "short", `${tokens.riya}x"; drop table`]) {
        const result = await scanCheckIn(token, gymA, owner, db, morning);
        assert.deepEqual(result, { result: "not_found" }, "nothing else is revealed");
    }
    assert.equal(db.tables.attendance.length, 0);
    assert.equal(db.calls.filter((call) => call.table === "members").length, 2, "malformed tokens are not even looked up");
});

test("expired members are recorded and flagged; members without a plan too", async () => {
    const db = fakeDb();
    const expired = await scanCheckIn(tokens.dev, gymA, owner, db, morning);
    assert.equal(expired.result, "expired");
    assert.equal(expired.membership.days_left, -3);
    assert.equal(expired.member.phone, "9876543211");
    const none = await scanCheckIn(tokens.neha, gymA, owner, db, morning);
    assert.equal(none.result, "no_membership");
    assert.equal(none.membership, null);
    assert.deepEqual(db.tables.attendance.map((row) => row.membership_status_at_check_in), ["expired", "none"]);
});

test("check-ins either side of midnight IST are two different days", async () => {
    const db = fakeDb();
    assert.equal((await scanCheckIn(tokens.riya, gymA, owner, db, new Date("2026-11-12T18:29:00Z"))).result, "checked_in");
    assert.equal((await scanCheckIn(tokens.riya, gymA, owner, db, new Date("2026-11-12T18:31:00Z"))).result, "checked_in");
    assert.equal((await scanCheckIn(tokens.riya, gymA, owner, db, new Date("2026-11-13T05:00:00Z"))).result, "already_checked_in");
    assert.deepEqual(db.tables.attendance.map((row) => row.check_in_date), ["2026-11-12", "2026-11-13"]);
});

test("reissuing a token stops the old QR working and the new one checks in", async () => {
    const db = fakeDb();
    const { qr_token: fresh } = await reissueQrToken(ids.riya, gymA, db);
    assert.notEqual(fresh, tokens.riya);
    assert.match(fresh, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(await scanCheckIn(tokens.riya, gymA, owner, db, morning), { result: "not_found" });
    assert.equal((await scanCheckIn(fresh, gymA, owner, db, morning)).result, "checked_in");
    await assert.rejects(reissueQrToken(ids.aisha, gymA, db), (error) => error.status === 404);
    assert.equal(db.tables.members.find((member) => member.id === ids.aisha).qr_token, tokens.aisha, "another gym's member is untouched");
});

test("manual check-in works for this gym's members only", async () => {
    const db = fakeDb();
    const result = await manualCheckIn(ids.riya, gymA, owner, db, morning);
    assert.equal(result.result, "checked_in");
    assert.equal(db.tables.attendance[0].method, "manual");
    await assert.rejects(manualCheckIn(ids.aisha, gymA, owner, db, morning), (error) => error.status === 404);
});

test("the attendance list only contains this gym's check-ins", async () => {
    const db = fakeDb();
    await scanCheckIn(tokens.riya, gymA, owner, db, morning);
    await scanCheckIn(tokens.aisha, gymB, owner, db, morning);
    const rows = await listAttendance({ date: "2026-11-12" }, gymA, db);
    assert.deepEqual(rows.map((row) => [row.member_id, row.member.full_name]), [[ids.riya, "Riya Shah"]]);
});

test("importing browser check-ins keeps this gym's members, one per day, with that day's status", async () => {
    const db = fakeDb();
    await scanCheckIn(tokens.riya, gymA, owner, db, morning);
    const result = await importAttendance([
        { member_id: ids.riya, checked_in_at: "2026-11-12T01:00:00Z" },
        { member_id: ids.riya, checked_in_at: "2026-11-05T03:00:00Z" },
        { member_id: ids.riya, checked_in_at: "2026-11-05T12:00:00Z" },
        { member_id: ids.dev, checked_in_at: "2026-11-05T03:00:00Z" },
        { member_id: ids.aisha, checked_in_at: "2026-11-05T03:00:00Z" },
        { member_id: ids.dev, checked_in_at: "2030-01-01T03:00:00Z" }
    ], gymA, owner, db, morning);
    assert.deepEqual(result, { imported: 2, already_recorded: 1, skipped: 3 });
    const imported = db.tables.attendance.filter((row) => row.check_in_date === "2026-11-05");
    assert.deepEqual(imported.map((row) => [row.member_id, row.membership_status_at_check_in, row.checked_in_at]).sort(),
        [[ids.dev, "active", "2026-11-05T03:00:00.000Z"], [ids.riya, "active", "2026-11-05T03:00:00.000Z"]].sort());
});

// ---------- Validation and rate limiting ----------

function invoke(middleware, request) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    let nextCalled = false;
    middleware(request, response, () => { nextCalled = true; });
    return { response, nextCalled, request };
}

test("scan and list requests are validated", () => {
    assert.equal(invoke(validateScan, { body: { token: tokens.riya } }).nextCalled, true);
    for (const body of [{}, { token: 5 }, { token: "x".repeat(201) }, { token: "a", gym_id: gymB }]) assert.equal(invoke(validateScan, { body }).nextCalled, false);
    assert.equal(invoke(validateAttendanceQuery, { query: { date: "2026-11-12" } }).nextCalled, true);
    assert.equal(invoke(validateAttendanceQuery, { query: { from: "2026-09-14", to: "2026-11-12" } }).nextCalled, true);
    for (const query of [{}, { date: "12-11-2026" }, { from: "2026-11-12", to: "2026-11-01" }, { date: "2026-02-30" }]) {
        assert.equal(invoke(validateAttendanceQuery, { query }).nextCalled, false, JSON.stringify(query));
    }
});

test("the scan endpoint is rate limited per signed-in user", async () => {
    const app = express();
    app.use((request, _response, next) => { request.authUser = { id: request.get("X-Test-User") }; next(); });
    app.post("/scan", createScanRateLimit({ windowMs: 60 * 1000, limit: 3 }), (_request, response) => response.json({ status: "success" }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/scan`;
    const scan = (user) => fetch(url, { method: "POST", headers: { "X-Test-User": user } });
    try {
        const statuses = [];
        for (let index = 0; index < 4; index += 1) statuses.push((await scan("staff-1")).status);
        assert.deepEqual(statuses, [200, 200, 200, 429]);
        const limited = await scan("staff-1");
        assert.match((await limited.json()).message, /Too many scans/);
        assert.equal((await scan("staff-2")).status, 200, "another device has its own allowance");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
