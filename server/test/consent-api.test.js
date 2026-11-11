import test from "node:test";
import assert from "node:assert/strict";
import { listConsentEvents, setWhatsAppConsent } from "../services/membersService.js";
import { validateConsentPayload, validateMemberPayload } from "../middleware/validateMember.js";

const gymA = "00000000-0000-4000-8000-0000000000a1";
const memberId = "00000000-0000-4000-8000-000000000001";

// A Supabase client mock that records calls and answers each table from `tables`.
function mockClient({ rpcResult = { data: null, error: null }, tables = {} } = {}) {
    const calls = [];
    return {
        calls,
        rpc(name, args) {
            calls.push({ rpc: name, args });
            return Promise.resolve(rpcResult);
        },
        from(table) {
            const call = { table, operations: [] };
            calls.push(call);
            const query = {};
            for (const method of ["select", "eq", "in", "is", "order", "range"]) {
                query[method] = (...args) => { call.operations.push([method, ...args]); return query; };
            }
            const filters = () => Object.fromEntries(call.operations.filter(([method]) => method === "eq").map(([, field, value]) => [field, value]));
            const rows = () => (tables[table] || []).filter((row) => Object.entries(filters()).every(([field, value]) => row[field] === value));
            query.maybeSingle = () => Promise.resolve({ data: rows()[0] || null, error: null });
            query.then = (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
            return query;
        }
    };
}

function invoke(middleware, request) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    let nextCalled = false;
    middleware(request, response, () => { nextCalled = true; });
    return { response, nextCalled, request };
}

test("granting consent calls the database function with the gym, source and recording owner", async () => {
    const client = mockClient({ rpcResult: { data: [{ id: memberId, gym_id: gymA, whatsapp_opt_in: true }], error: null } });
    const member = await setWhatsAppConsent(memberId, { optIn: true, source: "staff_form", recordedBy: "owner-1" }, gymA, client);
    assert.deepEqual(client.calls[0], {
        rpc: "gympulse_set_member_whatsapp_consent",
        args: { p_gym_id: gymA, p_member_id: memberId, p_opt_in: true, p_source: "staff_form", p_recorded_by: "owner-1" }
    });
    assert.equal(member.whatsapp_opt_in, true);
    assert.deepEqual(member.billing, { billed: 0, paid: 0, outstanding: 0 });
});

test("withdrawing consent for another gym's member is reported as not found", async () => {
    const client = mockClient({ rpcResult: { data: null, error: { code: "P0002" } } });
    await assert.rejects(
        setWhatsAppConsent(memberId, { optIn: false, source: "staff_form" }, gymA, client),
        (error) => error.status === 404
    );
    await assert.rejects(setWhatsAppConsent(memberId, { optIn: "yes", source: "staff_form" }, gymA, client), (error) => error.status === 400);
    await assert.rejects(setWhatsAppConsent(memberId, { optIn: true, source: "guess" }, gymA, client), (error) => error.status === 400);
});

test("gym A cannot read gym B's consent events", async () => {
    const gymB = "00000000-0000-4000-8000-0000000000b1";
    const client = mockClient({
        tables: {
            members: [{ id: memberId, gym_id: gymB }],
            member_consent_events: [{ id: "e1", gym_id: gymB, member_id: memberId, action: "granted" }]
        }
    });
    await assert.rejects(listConsentEvents(memberId, gymA, client), (error) => error.status === 404);
    assert.equal(client.calls.some((call) => call.table === "member_consent_events"), false);

    const own = mockClient({
        tables: {
            members: [{ id: memberId, gym_id: gymA }],
            member_consent_events: [
                { id: "e1", gym_id: gymA, member_id: memberId, action: "granted" },
                { id: "e2", gym_id: gymB, member_id: memberId, action: "withdrawn" }
            ]
        }
    });
    const events = await listConsentEvents(memberId, gymA, own);
    assert.deepEqual(events.map((event) => event.id), ["e1"]);
    const query = own.calls.find((call) => call.table === "member_consent_events");
    assert.ok(query.operations.some(([method, field, value]) => method === "eq" && field === "gym_id" && value === gymA));
});

test("the consent endpoint accepts only a true/false choice from the form or a CSV import", () => {
    assert.deepEqual(invoke(validateConsentPayload, { body: { opt_in: true } }).request.validatedConsent, { optIn: true, source: "staff_form" });
    assert.deepEqual(invoke(validateConsentPayload, { body: { opt_in: false, source: "csv_import" } }).request.validatedConsent, { optIn: false, source: "csv_import" });
    for (const body of [{}, { opt_in: "true" }, { opt_in: true, source: "member_reply_stop" }, { opt_in: true, recorded_by: "someone" }, []]) {
        const result = invoke(validateConsentPayload, { body });
        assert.equal(result.nextCalled, false, JSON.stringify(body));
        assert.equal(result.response.statusCode, 400);
    }
});

test("member create and update cannot set consent fields directly but accept contact and follow-up", () => {
    for (const field of ["whatsapp_opt_in", "whatsapp_opt_in_at", "whatsapp_opt_out_at"]) {
        const result = invoke(validateMemberPayload("update"), { body: { [field]: true } });
        assert.equal(result.nextCalled, false, field);
        assert.match(result.response.body.message, /protected field/);
    }
    const ok = invoke(validateMemberPayload("update"), { body: { emergency_contact: " 9823012345 ", follow_up_status: "contacted" } });
    assert.equal(ok.nextCalled, true);
    assert.deepEqual(ok.request.validatedMember, { emergency_contact: "9823012345", follow_up_status: "contacted" });
    assert.equal(invoke(validateMemberPayload("update"), { body: { follow_up_status: "ignored" } }).nextCalled, false);
});
