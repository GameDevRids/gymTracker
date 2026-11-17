// Enquiries above the database (migration 024 is covered by enquiry-migration.test.js): the shared rules,
// the service and API (consent, duplicates, Contacted, Join now, gym isolation), the page (WhatsApp only
// with consent, Join now carrying name, phone and consent, cancelling), Today and the numbers.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomUUID } from "node:crypto";
import { installPhotoDom } from "./helpers/fakeDom.js";
import {
    buildEnquiryMessage, cleanEnquiryPhone, enquiriesOnTab, enquiryTemplateProblem, followUpChoices, followUpState, monthStats, tabCounts
} from "../../assets/js/enquiries.js";
import * as service from "../services/enquiriesService.js";
import { createEnquiriesRouter } from "../routes/enquiries.js";
import { validateConsentPayload } from "../middleware/validateMember.js";

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// A stand-in page with a dialog root: what a dialog shows is kept in dialog.html, and the listeners added
// to its buttons in dialog.listeners (by selector and event), so a test can see and tap what opened.
const dialog = { html: "", listeners: {} };
function stubElement(selector = "") {
    return {
        dataset: {}, value: "", hidden: false, isConnected: true,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        elements: new Proxy({}, { get: () => ({ value: "", checked: false, closest: () => null }) }),
        querySelector: (inner) => stubElement(inner), querySelectorAll: () => [],
        addEventListener: (type, handler) => { dialog.listeners[`${selector} ${type}`] = handler; },
        removeEventListener() {}, focus() {}, append() {}, remove() {}, setAttribute() {}, replaceChildren() {}
    };
}
const modalRoot = {
    ...stubElement("#modal-root"),
    get innerHTML() { return dialog.html; },
    set innerHTML(html) { dialog.html = html; },
    replaceChildren() { dialog.html = ""; },
    childElementCount: 0
};
function installDialogDom() {
    const fetchNow = globalThis.fetch;
    const dom = installPhotoDom();
    globalThis.fetch = fetchNow;
    const saved = globalThis.HTMLElement;
    globalThis.HTMLElement ??= class {};
    globalThis.window.setTimeout = () => 0;
    Object.assign(globalThis.document, {
        activeElement: null,
        querySelector: (selector) => (selector === "#modal-root" ? modalRoot : stubElement(selector)),
        createElement: () => stubElement()
    });
    return { restore() { dom.restore(); if (saved === undefined) delete globalThis.HTMLElement; } };
}

const boot = installDialogDom();
const page = await import("../../assets/js/modules/enquiriesPage.js");
const { attentionItems, renderNeedsAttention } = await import("../../assets/js/modules/dashboard.js");
const { state } = await import("../../assets/js/state.js");
boot.restore();

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";
const owner = "00000000-0000-4000-8000-00000000000a";
const TODAY = "2026-11-17";

// ---------- A small stand-in for the database (the parts the service uses) ----------

function fakeDb({ members = [], enquiries = [], plans = [] } = {}) {
    const tables = {
        members: members.map((row) => ({ archived_at: null, phone_last10: String(row.phone).slice(-10), ...row })),
        enquiries: enquiries.map((row) => ({ id: randomUUID(), stage: "new", whatsapp_consent: false, whatsapp_consent_at: null, created_at: `${TODAY}T05:00:00Z`, updated_at: `${TODAY}T05:00:00Z`, ...row })),
        membership_plans: plans
    };
    const rpcs = [];
    const db = {
        tables,
        rpcs,
        rpc(name, args) { rpcs.push([name, args]); return Promise.resolve({ data: 0, error: null }); },
        from(table) {
            const filters = [];
            let action = "select";
            let payload = null;
            let limit = Infinity;
            const matches = (row) => filters.every(([kind, column, value]) => (kind === "eq" ? row[column] === value
                : kind === "in" ? value.includes(row[column]) : kind === "is" ? (row[column] ?? null) === value : kind === "lte" ? row[column] !== null && row[column] <= value : true));
            const run = () => {
                const list = tables[table];
                if (action === "insert") {
                    const row = { id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), follow_up_on: null, last_contacted_at: null, joined_member_id: null, ...payload };
                    // The database's rule: one open enquiry per phone per gym.
                    if (table === "enquiries" && list.some((other) => other.gym_id === row.gym_id && other.phone === row.phone && ["new", "contacted"].includes(other.stage))) {
                        return { data: null, error: { code: "23505" } };
                    }
                    list.push(row);
                    return { data: [row], error: null };
                }
                const hits = list.filter(matches);
                if (action === "update") { hits.forEach((row) => Object.assign(row, payload, { updated_at: new Date().toISOString() })); return { data: hits.map((row) => ({ ...row })), error: null }; }
                if (action === "delete") { tables[table] = list.filter((row) => !hits.includes(row)); return { data: hits, error: null }; }
                return { data: hits.slice(0, limit).map((row) => ({ ...row })), error: null };
            };
            const query = {
                select: () => query,
                eq: (column, value) => { filters.push(["eq", column, value]); return query; },
                in: (column, value) => { filters.push(["in", column, value]); return query; },
                is: (column, value) => { filters.push(["is", column, value]); return query; },
                lte: (column, value) => { filters.push(["lte", column, value]); return query; },
                order: () => query,
                limit: (count) => { limit = count; return query; },
                range: () => query,
                insert: (row) => { action = "insert"; payload = row; return query; },
                update: (row) => { action = "update"; payload = row; return query; },
                delete: () => { action = "delete"; return query; },
                single: () => { const result = run(); return Promise.resolve(result.error ? result : { data: result.data[0], error: null }); },
                maybeSingle: () => { const result = run(); return Promise.resolve({ data: result.data?.[0] || null, error: result.error }); },
                then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
            };
            return query;
        }
    };
    return db;
}

const input = (fields = {}) => ({ full_name: "Asha Rao", phone: "+919811111111", source: "walk_in", interest_plan_id: null, interest_text: "Not sure", note: null, follow_up_on: "2026-11-18", ...fields });
const ctx = { gymId: A, userId: owner, now: new Date("2026-11-17T06:00:00Z") };

// ---------- Shared rules ----------

test("phone numbers are cleaned to +91 and 10 digits, from the ways people write them", () => {
    for (const value of ["9876543210", "+91 98765 43210", "098765-43210", "919876543210", " (+91) 98765-43210 "]) {
        assert.equal(cleanEnquiryPhone(value), "+919876543210", value);
    }
    for (const value of ["12345", "5876543210", "98765432101", "abc9876543210", ""]) assert.equal(cleanEnquiryPhone(value), "", value);
});

test("follow-up quick dates: Tomorrow, In 3 days, Next week (India dates)", () => {
    assert.deepEqual(followUpChoices("2026-12-30").map(([, label, date]) => [label, date]), [["Tomorrow", "2026-12-31"], ["In 3 days", "2027-01-02"], ["Next week", "2027-01-06"]]);
});

const sample = [
    { id: "a", stage: "new", follow_up_on: "2026-11-15", created_at: "2026-11-02T05:00:00Z", source: "walk_in" },          // overdue
    { id: "b", stage: "contacted", follow_up_on: TODAY, created_at: "2026-11-10T05:00:00Z", source: "instagram" },        // today
    { id: "c", stage: "new", follow_up_on: "2026-11-25", created_at: "2026-11-16T05:00:00Z", source: "walk_in" },          // later
    { id: "d", stage: "new", follow_up_on: null, created_at: "2026-11-16T05:00:00Z", source: "friend" },                  // no date
    { id: "e", stage: "joined", follow_up_on: "2026-11-01", created_at: "2026-11-03T05:00:00Z", source: "walk_in" },      // joined
    { id: "f", stage: "not_interested", follow_up_on: "2026-11-02", created_at: "2026-11-04T05:00:00Z", source: "other" },
    { id: "g", stage: "joined", created_at: "2026-10-20T05:00:00Z", source: "instagram" }                                   // last month
];

test("Follow up today holds today's and overdue follow-ups of open enquiries; the other tabs by stage", () => {
    assert.deepEqual(enquiriesOnTab(sample, "today", TODAY).map((row) => row.id), ["a", "b"]);
    assert.deepEqual(enquiriesOnTab(sample, "open", TODAY).map((row) => row.id).sort(), ["a", "b", "c", "d"]);
    assert.deepEqual(enquiriesOnTab(sample, "joined", TODAY).map((row) => row.id).sort(), ["e", "g"]);
    assert.deepEqual(enquiriesOnTab(sample, "not_interested", TODAY).map((row) => row.id), ["f"]);
    assert.deepEqual(tabCounts(sample, TODAY), { today: 2, open: 4, joined: 2, not_interested: 1 });
    assert.deepEqual(["a", "b", "c", "d", "e"].map((id) => followUpState(sample.find((row) => row.id === id), TODAY)), ["overdue", "today", "later", "none", "none"]);
});

test("this month's numbers: enquiries, joined, conversion = joined ÷ enquiries, and by source", () => {
    const stats = monthStats(sample, TODAY);
    assert.deepEqual([stats.month, stats.enquiries, stats.joined, stats.conversion], ["2026-11", 6, 1, 17], "1 of 6 this month; the October one is not counted");
    assert.deepEqual(stats.bySource.find((row) => row.source === "walk_in"), { source: "walk_in", label: "Walk-in", enquiries: 3, joined: 1, conversion: 33 });
    assert.equal(monthStats([], TODAY).conversion, null, "no enquiries: no percentage");
    // An enquiry made just before midnight UTC on the 31st is November in India.
    assert.equal(monthStats([{ stage: "new", created_at: "2026-10-31T20:00:00Z", source: "walk_in" }], TODAY).enquiries, 1);
});

test("the message: first name, gym name and phone; a template only takes known placeholders", () => {
    assert.equal(buildEnquiryMessage("Hi {name}, thanks for visiting {gym_name}! Would you like to join? {gym_phone}", { name: "Asha Rao", gymName: "Power Gym", gymPhone: "+91 98220 01122" }),
        "Hi Asha, thanks for visiting Power Gym! Would you like to join? +91 98220 01122");
    assert.equal(buildEnquiryMessage("Hi {name}. Call {gym_phone}", { name: "", gymName: "" }), "Hi there. Call");
    assert.equal(enquiryTemplateProblem("Hi {name} from {gym_name}"), "");
    assert.match(enquiryTemplateProblem("Hi {first}"), /Unsupported placeholder/);
    assert.match(enquiryTemplateProblem("  "), /Enter/);
});

// ---------- The service ----------

test("adding an enquiry with consent saves the date; without consent saves none", async () => {
    const db = fakeDb();
    const agreed = await service.createEnquiry(input({ consent: true }), ctx, db);
    assert.equal(agreed.whatsapp_consent, true);
    assert.equal(agreed.whatsapp_consent_at, "2026-11-17T06:00:00.000Z");
    assert.equal(agreed.stage, "new");
    assert.equal(agreed.created_by, owner);
    const declined = await service.createEnquiry(input({ phone: "+919822222222", consent: false }), ctx, db);
    assert.deepEqual([declined.whatsapp_consent, declined.whatsapp_consent_at], [false, null], "No thanks still saves the enquiry");
    const later = await service.setEnquiryConsent(declined.id, true, ctx, db);
    assert.equal(later.whatsapp_consent, true, "Ask for consent can record it later");
});

test("a phone that is already a member, or already an open enquiry, is refused with which one it is", async () => {
    const db = fakeDb({
        members: [{ id: "m1", gym_id: A, full_name: "Riya Shah", phone: "9876543210" }, { id: "m2", gym_id: B, full_name: "Other gym", phone: "9811111111" }],
        enquiries: [{ id: "e1", gym_id: A, full_name: "Dev", phone: "+919833333333" }]
    });
    await assert.rejects(service.createEnquiry(input({ phone: "+919876543210" }), ctx, db), (error) => error.reason === "member_exists" && error.member_id === "m1" && /Riya Shah is already a member/.test(error.message));
    await assert.rejects(service.createEnquiry(input({ phone: "+919833333333" }), ctx, db), (error) => error.reason === "enquiry_exists" && error.enquiry_id === "e1");
    assert.ok(await service.createEnquiry(input({ phone: "+919811111111" }), ctx, db), "another gym's member with the same phone does not count");
});

test("opening WhatsApp sets Contacted and the time, only with consent", async () => {
    const db = fakeDb({ enquiries: [{ id: "yes", gym_id: A, full_name: "A", phone: "+919811111111", whatsapp_consent: true, whatsapp_consent_at: "2026-11-17T05:00:00Z" }, { id: "no", gym_id: A, full_name: "B", phone: "+919822222222" }] });
    const done = await service.markContacted("yes", { follow_up_on: "2026-11-20" }, ctx, db);
    assert.deepEqual([done.stage, done.last_contacted_at, done.follow_up_on], ["contacted", "2026-11-17T06:00:00.000Z", "2026-11-20"]);
    await assert.rejects(service.markContacted("no", {}, ctx, db), (error) => error.reason === "no_consent");
});

test("Join now: the enquiry becomes Joined only for a member of this gym with the same phone", async () => {
    const db = fakeDb({
        members: [{ id: "m1", gym_id: A, full_name: "Asha", phone: "9811111111" }, { id: "m2", gym_id: A, full_name: "Someone", phone: "9899999999" }, { id: "m3", gym_id: B, full_name: "Asha", phone: "9811111111" }],
        enquiries: [{ id: "e1", gym_id: A, full_name: "Asha", phone: "+919811111111", follow_up_on: TODAY }]
    });
    await assert.rejects(service.joinEnquiry("e1", "m2", ctx, db), (error) => error.reason === "phone_mismatch");
    await assert.rejects(service.joinEnquiry("e1", "m3", ctx, db), (error) => error.status === 404, "another gym's member");
    const joined = await service.joinEnquiry("e1", "m1", ctx, db);
    assert.deepEqual([joined.stage, joined.joined_member_id, joined.follow_up_on], ["joined", "m1", null]);
    assert.equal((await service.joinEnquiry("e1", "m1", ctx, db)).stage, "joined", "repeating it is harmless");
    await assert.rejects(service.updateEnquiry("e1", { note: "x" }, ctx, db), (error) => error.reason === "joined");
});

test("another gym can't see, change, contact, join or delete these enquiries", async () => {
    const db = fakeDb({ enquiries: [{ id: "e1", gym_id: A, full_name: "Asha", phone: "+919811111111", whatsapp_consent: true, whatsapp_consent_at: "2026-11-17T05:00:00Z" }] });
    const other = { gymId: B, userId: owner, now: ctx.now };
    assert.deepEqual((await service.listEnquiries(B, db, TODAY)).enquiries, []);
    for (const attempt of [
        service.updateEnquiry("e1", { note: "x" }, other, db), service.setEnquiryConsent("e1", false, other, db),
        service.markContacted("e1", {}, other, db), service.joinEnquiry("e1", "m1", other, db), service.deleteEnquiry("e1", other, db)
    ]) await assert.rejects(attempt, (error) => error.status === 404);
    assert.equal(db.tables.enquiries[0].note, undefined, "nothing changed");
    assert.equal((await service.listEnquiries(A, db, TODAY)).enquiries.length, 1);
});

test("the list cleans up old enquiries first, and counts follow-ups due for the badge", async () => {
    const db = fakeDb({ enquiries: sample.map((row) => ({ ...row, id: undefined, gym_id: A, full_name: row.id, phone: `+91981111111${row.id.charCodeAt(0) % 10}` })) });
    const list = await service.listEnquiries(A, db, TODAY);
    assert.deepEqual(db.rpcs[0], ["gympulse_purge_old_enquiries", { p_gym_id: A }]);
    assert.deepEqual(list.counts, { today: 2, open: 4, joined: 2, not_interested: 1 });
    assert.equal(list.stats.joined, 1);
    assert.equal(await service.dueEnquiryCount(A, db, TODAY), 2);
    assert.equal(await service.dueEnquiryCount(B, db, TODAY), 0);
    assert.equal(await service.purgeOldEnquiries(null, db), 0);
    assert.deepEqual(db.rpcs.at(-1), ["gympulse_purge_old_enquiries", { p_gym_id: null }], "the hourly run covers every gym");
});

test("deleting removes the enquiry completely", async () => {
    const db = fakeDb({ enquiries: [{ id: "e1", gym_id: A, full_name: "Asha", phone: "+919811111111" }] });
    await service.deleteEnquiry("e1", ctx, db);
    assert.equal(db.tables.enquiries.length, 0);
    await assert.rejects(service.deleteEnquiry("e1", ctx, db), (error) => error.status === 404);
});

// ---------- The API ----------

async function call(method, path, body, { gymId = A } = {}) {
    const db = call.db;
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.gymId = gymId; request.authUser = { id: owner }; next(); });
    app.use("/api/enquiries", createEnquiriesRouter({
        listEnquiries: (gym) => service.listEnquiries(gym, db, TODAY),
        createEnquiry: (data, context) => service.createEnquiry(data, context, db),
        updateEnquiry: (id, changes, context) => service.updateEnquiry(id, changes, context, db),
        setEnquiryConsent: (id, agree, context) => service.setEnquiryConsent(id, agree, context, db),
        markContacted: (id, data, context) => service.markContacted(id, data, context, db),
        joinEnquiry: (id, member, context) => service.joinEnquiry(id, member, context, db),
        deleteEnquiry: (id, context) => service.deleteEnquiry(id, context, db)
    }));
    const server = app.listen(0);
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, body: await response.json() };
    } finally {
        server.close();
    }
}

test("API: add with the phone as typed; a duplicate answers with the member or enquiry to open; the gym comes from the sign-in", async () => {
    call.db = fakeDb({ members: [{ id: "m1", gym_id: A, full_name: "Riya Shah", phone: "9876543210" }] });
    const added = await call("POST", "/api/enquiries", { full_name: "Asha Rao", phone: "098111 11111", source: "instagram", consent: true, follow_up_on: "2026-11-18" });
    assert.equal(added.status, 201);
    assert.deepEqual([added.body.data.phone, added.body.data.gym_id, added.body.data.whatsapp_consent], ["+919811111111", A, true]);
    const member = await call("POST", "/api/enquiries", { full_name: "Riya", phone: "+91 98765 43210", source: "walk_in" });
    assert.deepEqual([member.status, member.body.code, member.body.member_id], [409, "member_exists", "m1"]);
    const again = await call("POST", "/api/enquiries", { full_name: "Asha", phone: "9811111111", source: "walk_in" });
    assert.deepEqual([again.status, again.body.code, again.body.enquiry_id], [409, "enquiry_exists", added.body.data.id]);
    const sneaky = await call("POST", "/api/enquiries", { full_name: "X", phone: "9822222222", source: "walk_in", gym_id: B });
    assert.equal(sneaky.status, 400, "a gym_id in the body is refused");
    assert.equal((await call("POST", "/api/enquiries", { full_name: "X", phone: "12345", source: "walk_in" })).body.message, "Enter a 10-digit Indian mobile number.");
    assert.equal((await call("PUT", `/api/enquiries/${added.body.data.id}`, { stage: "joined" })).status, 400, "Joined only through Join now");
    assert.equal((await call("GET", "/api/enquiries", null, { gymId: B })).body.data.enquiries.length, 0);
});

test("consent carried over on Join now is accepted as the 'enquiry' source", () => {
    const run = (body) => { let ok = false; const request = { body }; validateConsentPayload(request, { status() { return this; }, json() { return this; } }, () => { ok = true; }); return [ok, request.validatedConsent]; };
    assert.deepEqual(run({ opt_in: true, source: "enquiry" }), [true, { optIn: true, source: "enquiry" }]);
    assert.equal(run({ opt_in: true, source: "member_reply_stop" })[0], false);
});

// ---------- The page ----------

const enquiryRow = (fields) => ({ id: randomUUID(), gym_id: A, full_name: "Asha Rao", phone: "+919811111111", source: "walk_in", stage: "new", follow_up_on: TODAY, whatsapp_consent: false, whatsapp_consent_at: null, created_at: `${TODAY}T05:00:00Z`, updated_at: `${TODAY}T05:00:00Z`, ...fields });

function withPage(rows, run) {
    Object.assign(page.enquiries, { status: "ready", list: rows, today: TODAY, loaded: true, message: "" });
    state.gym.name = "Power Gym";
    state.gym.phone = "9822001122";
    return run();
}

test("the WhatsApp button is there only with consent; otherwise 'No WhatsApp consent' and Ask for consent", () => withPage([
    enquiryRow({ id: "with", whatsapp_consent: true, whatsapp_consent_at: `${TODAY}T05:00:00Z` }),
    enquiryRow({ id: "without", phone: "+919822222222" })
], () => {
    page.setEnquiryTab("today");
    const html = page.renderEnquiriesPage();
    assert.equal((html.match(/data-enquiry-whatsapp=/g) || []).length, 1);
    assert.match(html, /data-enquiry-whatsapp="with"/);
    assert.match(html, /No WhatsApp consent<\/span><button[^>]*data-action="enquiry-ask-consent" data-id="without">Ask for consent/);
    const link = decodeURIComponent(html.match(/href="https:\/\/wa\.me\/91(\d+)\?text=([^"]+)"/)[2]);
    assert.match(link, /^Hi Asha, thanks for visiting Power Gym! Would you like to join\? \+91 98220 01122$/);
    assert.equal(page.enquiryWhatsApp({ whatsapp_consent: false }).blocked, "No WhatsApp consent");
}));

test("overdue follow-ups use the red urgency style; tabs show their counts", () => withPage([
    enquiryRow({ id: "late", follow_up_on: "2026-11-10" }), enquiryRow({ id: "now", phone: "+919822222222" })
], () => {
    page.setEnquiryTab("today");
    const html = page.renderEnquiriesPage();
    assert.match(html, /class="card enquiry-card is-overdue" data-enquiry-row="late"/);
    assert.match(html, /badge-soft expiry-overdue">Overdue/);
    assert.match(html, /Follow up today <span class="count-pill">2<\/span>/);
    assert.equal(page.dueEnquiries(), 2);
}));

test("the page shows this month's numbers with the formula in plain words", () => withPage(sample.map((row) => enquiryRow({ ...row, phone: `+9198111111${row.id.charCodeAt(0)}`.slice(0, 13) })), () => {
    const html = page.renderEnquiriesPage();
    assert.match(html, /<strong>6<\/strong> enquiries this month/);
    assert.match(html, /<strong>1<\/strong> joined/);
    assert.match(html, /<strong>17%<\/strong> conversion/);
    assert.match(html, /Of the 6 people who enquired in November, 1 joined: 1 ÷ 6 = 17%\./);
    assert.match(html, /<span>Walk-in<\/span><strong>3<\/strong><small>1 joined · 33%<\/small>/);
}));

test("opening WhatsApp tells the server (Contacted), then asks for the next follow-up date", async () => {
    const row = enquiryRow({ id: "e1", whatsapp_consent: true, whatsapp_consent_at: `${TODAY}T05:00:00Z` });
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push([String(url), options.method]);
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ status: "success", data: { ...row, stage: "contacted", last_contacted_at: "2026-11-17T06:00:00Z" } }) };
    };
    const dom = installDialogDom();
    try {
        await withPage([row], () => page.recordEnquiryMessage("e1", () => {}));
    } finally {
        dom.restore();
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], "POST");
    assert.match(dialog.html, /When to follow up next\?/);
    assert.match(dialog.html, /Asha Rao is marked Contacted\./);
    assert.match(dialog.html, />Skip</);
    assert.match(calls[0][0], /\/api\/enquiries\/e1\/contacted$/);
    assert.equal(page.enquiries.list[0].stage, "contacted");
});

test("Join now opens the member form with the name, phone and consent; nothing is saved until the member is", () => withPage([
    enquiryRow({ id: "e1", whatsapp_consent: true, whatsapp_consent_at: "2026-11-15T05:00:00Z", interest_plan_id: "plan-1" })
], () => {
    state.members = [];
    const calls = [];
    globalThis.fetch = async (...args) => { calls.push(args); throw new Error("no request expected"); };
    let opened = null;
    assert.equal(page.handleEnquiryAction("enquiry-join", { dataset: { id: "e1" } }, { openMemberForm: (id, fill) => { opened = [id, fill]; }, onChange: () => {} }), true);
    assert.deepEqual(opened, ["", { enquiryId: "e1", name: "Asha Rao", phone: "9811111111", whatsappOptIn: true, consentAt: "2026-11-15T05:00:00Z", planId: "plan-1" }]);
    // Cancelling the form: no request was made, the enquiry is still open.
    assert.equal(calls.length, 0);
    assert.equal(page.enquiries.list[0].stage, "new");
}));

test("after the member is saved the enquiry is linked; without consent the form gets none", async () => {
    await withPage([enquiryRow({ id: "e2" })], () => {
        let opened = null;
        page.handleEnquiryAction("enquiry-join", { dataset: { id: "e2" } }, { openMemberForm: (id, fill) => { opened = fill; }, onChange: () => {} });
        assert.equal(opened.whatsappOptIn, false);
    });
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push([String(url), options.method, JSON.parse(options.body || "{}")]);
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ status: "success", data: enquiryRow({ id: "e2", stage: "joined", joined_member_id: "m9" }) }) };
    };
    assert.equal(await page.linkEnquiryToMember("e2", "m9"), true);
    assert.match(calls[0][0], /\/api\/enquiries\/e2\/join$/);
    assert.deepEqual(calls[0][2], { member_id: "m9" });
    assert.equal(page.enquiries.list.find((row) => row.id === "e2").stage, "joined");
});

test("Join now for a phone that is already a member links them instead of adding a second member", () => withPage([enquiryRow({ id: "e3" })], () => {
    state.members = [{ id: "m1", name: "Asha Rao", phone: "9811111111" }];
    let formOpened = false;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push([String(url), JSON.parse(options.body || "{}")]);
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ status: "success", data: enquiryRow({ id: "e3", stage: "joined", joined_member_id: "m1" }) }) };
    };
    const dom = installDialogDom();
    page.handleEnquiryAction("enquiry-join", { dataset: { id: "e3" } }, { openMemberForm: () => { formOpened = true; }, onChange: () => {} });
    assert.equal(formOpened, false, "no second member form");
    assert.match(dialog.html, /Already a member/);
    assert.equal(calls.length, 0, "nothing changes until Mark joined");
    return Promise.resolve(dialog.listeners["#enquiry-link-existing click"]()).then(() => {
        assert.match(calls[0][0], /\/api\/enquiries\/e3\/join$/);
        assert.deepEqual(calls[0][1], { member_id: "m1" });
        assert.equal(page.enquiries.list[0].stage, "joined");
    }).finally(() => { dom.restore(); state.members = []; });
}));

test("the add form cleans the phone and needs a name; Not sure has no plan", () => {
    assert.deepEqual(page.enquiryFormBody({ full_name: " Asha ", phone: "098111-11111", source: "friend", interest_plan_id: "", note: "  ", follow_up_on: "2026-11-18" }).body, {
        full_name: "Asha", phone: "+919811111111", interest_plan_id: null, interest_text: "Not sure", source: "friend", note: null, follow_up_on: "2026-11-18"
    });
    assert.match(page.enquiryFormBody({ full_name: "", phone: "9811111111" }).problem, /name/);
    assert.match(page.enquiryFormBody({ full_name: "A", phone: "12" }).problem, /10-digit/);
    assert.equal(page.enquiryFormBody({ full_name: "A", phone: "9811111111", interest_plan_id: "p1" }).body.interest_text, null);
});

// ---------- Today ----------

test("Today's Needs attention has 'Enquiries to follow up', opening the Follow up today tab", () => {
    const item = attentionItems({ status_counts: { expiring: 0, in_grace: 0 }, enquiries_due: 3 }, 0).find((entry) => entry.key === "enquiries");
    assert.deepEqual([item.label, item.value, item.view, item.tab], ["Enquiries to follow up", 3, "enquiries", "today"]);
    assert.equal(attentionItems({ enquiries_due: 3 }, 0, 5).find((entry) => entry.key === "enquiries").value, 5, "the loaded list wins over the summary");
    const html = renderNeedsAttention({ status_counts: { expiring: 0, in_grace: 0 }, members_with_balance: 0, enquiries_due: 2 }, 0);
    assert.match(html, /data-view="enquiries" data-tab="today"><strong>2<\/strong><span>Enquiries to follow up/);
});
