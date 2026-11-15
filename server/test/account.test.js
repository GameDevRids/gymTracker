import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { GYM_COLUMNS, requireAuth } from "../middleware/requireAuth.js";
import { createAccountRouter } from "../routes/account.js";
import {
    acceptTerms, cancelGymDeletion, eraseGym, getAccountStatus, purgeDueGyms, requestGymDeletion, supportWhatsApp
} from "../services/accountService.js";
import { TERMS_VERSION } from "../../assets/js/legal.js";

process.env.SUPABASE_URL = "https://gympulse-auth.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "server-only-test-key";

const userId = "00000000-0000-4000-8000-000000000001";
const gymId = "00000000-0000-4000-8000-0000000000a1";

/**
 * A fake Supabase client. answers[table] is a function (query) => { data, error, count } that
 * sees every filter, so each test decides what the database returns.
 */
function fakeClient(answers = {}, extra = {}) {
    const queries = [];
    const client = {
        queries,
        from(table) {
            const query = { table, op: "select", filters: [], values: null, columns: null };
            queries.push(query);
            const result = () => Promise.resolve((answers[table] || (() => ({ data: null, error: null })))(query));
            const builder = {
                select(columns) { if (query.op === "select") query.columns = columns; return builder; },
                insert(values) { query.op = "insert"; query.values = values; return builder; },
                update(values) { query.op = "update"; query.values = values; return builder; },
                eq(column, value) { query.filters.push(["eq", column, value]); return builder; },
                is(column, value) { query.filters.push(["is", column, value]); return builder; },
                gt(column, value) { query.filters.push(["gt", column, value]); return builder; },
                lte(column, value) { query.filters.push(["lte", column, value]); return builder; },
                order() { return builder; },
                limit() { return builder; },
                maybeSingle: result,
                then: (resolve, reject) => result().then(resolve, reject)
            };
            return builder;
        },
        ...extra
    };
    return client;
}

function stubFetch(handler) {
    const original = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : undefined });
        const [status, data] = handler(String(url), options);
        return { ok: status < 400, status, json: async () => data };
    };
    return { requests, restore: () => { globalThis.fetch = original; } };
}

// ---------- Service ----------

test("supportWhatsApp accepts common ways of writing an Indian mobile, and nothing else", () => {
    for (const value of ["9876543210", "+91 98765 43210", "91-98765-43210", "09876543210"]) {
        assert.equal(supportWhatsApp({ SUPPORT_WHATSAPP_NUMBER: value }), "919876543210", value);
    }
    for (const value of ["", "12345", "5876543210", "+1 415 555 0100"]) {
        assert.equal(supportWhatsApp({ SUPPORT_WHATSAPP_NUMBER: value }), "", value);
    }
});

test("account status reports this version's agreement and the gym's deletion", async () => {
    const client = fakeClient({
        terms_acceptances: () => ({ data: { terms_version: TERMS_VERSION, accepted_at: "2026-11-16T10:00:00Z" }, error: null }),
        gyms: () => ({ data: { deletion_requested_at: "2026-11-16T10:00:00Z", deletion_scheduled_for: "2026-11-23T10:00:00Z" }, error: null })
    });
    const status = await getAccountStatus({ userId, gymId }, client);
    assert.deepEqual(status.terms, { version: TERMS_VERSION, accepted_at: "2026-11-16T10:00:00Z" });
    assert.deepEqual(status.deletion, { requested_at: "2026-11-16T10:00:00Z", scheduled_for: "2026-11-23T10:00:00Z" });
    assert.deepEqual(client.queries[0].filters, [["eq", "user_id", userId], ["eq", "terms_version", TERMS_VERSION]]);
});

test("account status asks for migration 017 when its tables are missing", async () => {
    const client = fakeClient({ terms_acceptances: () => ({ data: null, error: { code: "PGRST205" } }) });
    await assert.rejects(getAccountStatus({ userId, gymId }, client), { status: 503, message: /017_add_terms_and_gym_deletion/ });
});

test("agreeing stores the current version only, and agreeing twice is fine", async () => {
    let answer = { data: null, error: null };
    const client = fakeClient({ terms_acceptances: () => answer });
    await acceptTerms(userId, TERMS_VERSION, client);
    assert.deepEqual(client.queries[0].values, { user_id: userId, terms_version: TERMS_VERSION });
    answer = { data: null, error: { code: "23505" } };
    await acceptTerms(userId, TERMS_VERSION, client);
    await assert.rejects(acceptTerms(userId, "2020-01-01", client), { status: 409 });
});

test("a deletion request needs the gym's name and the right password, then locks for 7 days", async () => {
    const client = fakeClient({ gyms: (query) => ({ data: query.op === "update" ? [query.values] : null, error: null }) });
    let passwordOk = false;
    const fetchStub = stubFetch((url) => {
        if (url.includes("grant_type=password")) return passwordOk ? [200, { access_token: "check-token" }] : [400, { error_code: "invalid_credentials" }];
        return [200, {}];
    });
    try {
        const base = { gymId, gymName: "Power Gym", userId, email: "owner@example.test", password: "secret-pass" };
        await assert.rejects(requestGymDeletion({ ...base, confirmName: "Other Gym" }, client), { status: 400, message: /gym's name/ });
        await assert.rejects(requestGymDeletion({ ...base, confirmName: "power gym" }, client), { status: 400, message: /current password is not right/ });
        assert.equal(client.queries.length, 0, "nothing is changed without the password");

        passwordOk = true;
        const before = Date.now();
        const deletion = await requestGymDeletion({ ...base, confirmName: " power gym " }, client);
        const days = (new Date(deletion.scheduled_for) - new Date(deletion.requested_at)) / 86400000;
        assert.equal(days, 7);
        assert.ok(new Date(deletion.requested_at).getTime() >= before - 1000);
        const update = client.queries[0];
        assert.equal(update.values.deletion_requested_by, userId);
        assert.deepEqual(update.filters, [["eq", "id", gymId], ["is", "deletion_scheduled_for", null]]);
        // The session the password check opened is closed straight away.
        assert.ok(fetchStub.requests.some((request) => request.url.endsWith("logout?scope=local")));
    } finally {
        fetchStub.restore();
    }
});

test("the demo gym cannot be deleted", async () => {
    process.env.DEMO_GYM_IDS = gymId;
    try {
        await assert.rejects(requestGymDeletion({ gymId, gymName: "Demo", confirmName: "Demo", password: "x", email: "e@x.test", userId }, fakeClient()), { status: 403 });
    } finally {
        delete process.env.DEMO_GYM_IDS;
    }
});

test("cancelling only works while the 7 days are running", async () => {
    let rows = [{ id: gymId }];
    const client = fakeClient({ gyms: () => ({ data: rows, error: null }) });
    await cancelGymDeletion(gymId, client);
    assert.deepEqual(client.queries[0].values, { deletion_requested_at: null, deletion_scheduled_for: null, deletion_requested_by: null });
    assert.equal(client.queries[0].filters[1][0], "gt");
    rows = [];
    await assert.rejects(cancelGymDeletion(gymId, client), { status: 409 });
});

test("erasing a gym removes its photos, then its rows, then accounts left without a gym", async () => {
    const order = [];
    const removed = [];
    const deletedUsers = [];
    const staffWithOtherGym = "00000000-0000-4000-8000-000000000002";
    const storage = {
        from(bucket) {
            assert.equal(bucket, "member-photos");
            return {
                async list(prefix) {
                    order.push(`list ${prefix}`);
                    if (prefix === gymId) return { data: [{ name: "m1", id: null }, { name: "m2", id: null }], error: null };
                    return { data: [{ name: `${prefix.endsWith("m1") ? "a" : "b"}.jpg`, id: "file" }], error: null };
                },
                async remove(paths) { order.push("remove"); removed.push(...paths); return { error: null }; }
            };
        }
    };
    const client = fakeClient({
        gym_users: (query) => ({ count: query.filters[0][2] === staffWithOtherGym ? 1 : 0, error: null })
    }, {
        storage,
        rpc: async (name, args) => {
            order.push(`rpc ${name}`);
            assert.deepEqual(args, { p_gym_id: gymId });
            return { data: [userId, staffWithOtherGym], error: null };
        },
        auth: { admin: { deleteUser: async (id) => { deletedUsers.push(id); return { error: null }; } } }
    });
    const result = await eraseGym(gymId, client);
    assert.deepEqual(result, { photos: 2, accounts: 1 });
    assert.deepEqual(removed.sort(), [`${gymId}/m1/a.jpg`, `${gymId}/m2/b.jpg`]);
    assert.ok(order.indexOf("rpc gympulse_delete_gym") > order.lastIndexOf("remove"), "photos go before the rows");
    assert.deepEqual(deletedUsers, [userId], "a user who still has another gym keeps their account");
});

test("if photos cannot be removed, the rows stay so the next sweep can try again", async () => {
    let rpcCalled = false;
    const client = fakeClient({ gyms: () => ({ data: [{ id: gymId }], error: null }) }, {
        storage: { from: () => ({ list: async () => ({ data: null, error: { message: "down" } }) }) },
        rpc: async () => { rpcCalled = true; return { data: [], error: null }; }
    });
    assert.deepEqual(await purgeDueGyms(client), { erased: 0 });
    assert.equal(rpcCalled, false);
});

test("the sweep does nothing before migration 017", async () => {
    const client = fakeClient({ gyms: () => ({ data: null, error: { code: "42703" } }) });
    assert.deepEqual(await purgeDueGyms(client), { erased: 0 });
});

// ---------- requireAuth: the lock, and running before migration 017 ----------

function authClient({ gyms, missingColumns = false }) {
    const selects = [];
    return {
        selects,
        auth: { getUser: async () => ({ data: { user: { id: userId, email: "owner@example.test" } }, error: null }) },
        from() {
            let columns;
            const builder = {
                select(value) { columns = value; selects.push(value); return builder; },
                eq() { return builder; },
                maybeSingle: async () => (missingColumns && columns === GYM_COLUMNS
                    ? { data: null, error: { code: "42703" } }
                    : { data: { gym_id: gymId, role: "owner", gyms }, error: null })
            };
            return builder;
        }
    };
}

async function runAuth(options) {
    const request = { get: () => "Bearer token" };
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    let passed = false;
    await requireAuth(options)(request, response, (error) => { if (error) throw error; passed = true; });
    return { request, response, passed };
}

test("a gym waiting to be erased is locked (423) except on routes that allow it", async () => {
    const client = authClient({ gyms: { id: gymId, name: "Gym", deletion_scheduled_for: "2026-11-23T10:00:00Z" } });
    const locked = await runAuth({ client });
    assert.equal(locked.passed, false);
    assert.equal(locked.response.statusCode, 423);
    assert.equal(locked.response.body.code, "gym_deletion_pending");
    const allowed = await runAuth({ client, allowPendingDeletion: true });
    assert.equal(allowed.passed, true);
    assert.equal(allowed.request.gymId, gymId);
});

test("before migration 017, sign-in still works with the older columns", async () => {
    const client = authClient({ gyms: { id: gymId, name: "Gym" }, missingColumns: true });
    const result = await runAuth({ client });
    assert.equal(result.passed, true);
    assert.deepEqual(client.selects, [GYM_COLUMNS, "gym_id,role,gyms(id,name)"]);
});

// ---------- Routes, with a fake service ----------

let server;
let baseUrl;
const calls = [];
let role = "owner";

before(async () => {
    const service = {
        getAccountStatus: async (args) => { calls.push(["status", args]); return { terms: { version: TERMS_VERSION, accepted_at: null }, deletion: null, support_whatsapp: "" }; },
        acceptTerms: async (...args) => { calls.push(["terms", ...args]); return { version: args[1] }; },
        requestGymDeletion: async (args) => { calls.push(["delete", args]); return { requested_at: "a", scheduled_for: "b" }; },
        cancelGymDeletion: async (id) => { calls.push(["cancel", id]); }
    };
    const app = express();
    app.use(express.json());
    app.use("/api/account", (request, _response, next) => {
        request.authUser = { id: userId, email: "owner@example.test" };
        request.gymId = gymId;
        request.gym = { id: gymId, name: "Power Gym" };
        request.gymRole = role;
        next();
    }, createAccountRouter(service));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/account`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const post = (path, body) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("routes pass the signed-in user and gym, and check their input", async () => {
    calls.length = 0;
    role = "owner";
    assert.equal((await fetch(`${baseUrl}/status`)).status, 200);
    assert.equal((await post("/terms", { version: TERMS_VERSION })).status, 200);
    assert.equal((await post("/terms", { version: TERMS_VERSION, extra: 1 })).status, 400);
    assert.equal((await post("/delete-gym", { confirm_name: "Power Gym" })).status, 400, "the password is required");
    const deleted = await post("/delete-gym", { confirm_name: "Power Gym", password: "secret-pass" });
    assert.equal(deleted.status, 200);
    assert.deepEqual((await deleted.json()).data.deletion, { requested_at: "a", scheduled_for: "b" });
    assert.equal((await post("/cancel-deletion", {})).status, 200);
    assert.deepEqual(calls.map((call) => call[0]), ["status", "terms", "delete", "cancel"]);
    assert.deepEqual(calls[0][1], { userId, gymId });
    assert.deepEqual(calls[1].slice(1), [userId, TERMS_VERSION]);
    assert.equal(calls[2][1].gymName, "Power Gym");
    assert.equal(calls[2][1].email, "owner@example.test");
});

test("only the owner can delete the gym or cancel it", async () => {
    calls.length = 0;
    role = "staff";
    try {
        assert.equal((await post("/delete-gym", { confirm_name: "Power Gym", password: "secret-pass" })).status, 403);
        assert.equal((await post("/cancel-deletion", {})).status, 403);
        assert.equal((await post("/terms", { version: TERMS_VERSION })).status, 200, "staff agree to the Terms for themselves");
        assert.deepEqual(calls.map((call) => call[0]), ["terms"]);
    } finally {
        role = "owner";
    }
});
