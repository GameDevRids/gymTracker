// Stage 2: what used to live only in the browser is saved for the gym in the database.
// Covers the API rules (validators and services, with a fake Supabase client) and the
// browser-side rules that have no DOM (reminder message, CSV cells, the one-time move).
import test from "node:test";
import assert from "node:assert/strict";

// Browser storage that fails on every call: nothing below may depend on it.
globalThis.localStorage = {
    getItem() { throw new Error("storage blocked"); },
    setItem() { throw new Error("storage blocked"); },
    removeItem() { throw new Error("storage blocked"); }
};

const { validateMessagePayload, validateTemplateBody, validateTemplateParams } = await import("../middleware/validateWhatsAppMessage.js");
const { validateGymSettings, validateLocalDataImport } = await import("../middleware/validateGymSettings.js");
const { effectivePreferences, fillUnsetPreferences, getGymSettings, saveGymSettings, sessionPreferences } = await import("../services/gymSettingsService.js");
const { expiryRemindersFor, importExpiryReminders, recordMemberMessage } = await import("../services/whatsappMessagesService.js");
const { assertPhoneAvailable, createMember } = await import("../services/membersService.js");
const { getGymSummary } = await import("../services/summaryService.js");
const { DEFAULT_REMINDER_TEMPLATES, buildReminderMessage, reminderTemplateProblem } = await import("../../assets/js/reminderMessage.js");
const { csvCell, visitDay } = await import("../../assets/js/utils.js");
const { collectLocalData } = await import("../../assets/js/localDataMove.js");
const { getLanguage, setLanguage } = await import("../../assets/js/i18n.js");
const { memberFromApiRow } = await import("../../assets/js/state.js");
const { readSavedWorkspace, readUiPreferences, saveUiPreferences } = await import("../../assets/js/storage.js");

const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
const memberA = "00000000-0000-4000-8000-000000000001";
const memberB = "00000000-0000-4000-8000-000000000002";
const membershipA = "00000000-0000-4000-8000-0000000000c1";
const membershipB = "00000000-0000-4000-8000-0000000000c2";

function invoke(middleware, request) {
    const response = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    let nextCalled = false;
    middleware(request, response, () => { nextCalled = true; });
    return { request, response, nextCalled };
}

// A small stand-in for the Supabase query builder: eq/neq/is/in filter the given rows.
function fakeClient(tables = {}, { errors = {}, rpc } = {}) {
    const calls = [];
    return {
        calls,
        rpc: rpc || (async () => ({ data: null, error: null })),
        from(table) {
            const call = { table, operations: [] };
            calls.push(call);
            const query = {};
            for (const method of ["select", "eq", "neq", "is", "in", "order", "limit", "range", "insert", "upsert", "update", "delete"]) {
                query[method] = (...args) => { call.operations.push([method, ...args]); return query; };
            }
            const rows = () => (tables[table] || []).filter((row) => call.operations.every(([method, field, value]) => {
                if (typeof field === "string" && field.includes(".")) return true;
                if (method === "eq") return row[field] === value;
                if (method === "neq") return row[field] !== value;
                if (method === "is") return (row[field] ?? null) === value;
                if (method === "in") return value.includes(row[field]);
                return true;
            }));
            const written = () => call.operations.find(([method]) => ["insert", "upsert"].includes(method))?.[1];
            const result = (data) => Promise.resolve(errors[table] ? { data: null, error: errors[table] } : { data, error: null });
            query.maybeSingle = () => result(rows()[0] || null);
            query.single = () => result({ id: "new", ...written() });
            query.then = (resolve, reject) => result(rows()).then(resolve, reject);
            return query;
        }
    };
}

// ---------- Validators ----------

test("an expiry reminder must name its membership; other messages must not", () => {
    const ok = invoke(validateMessagePayload, { body: { reminder_type: "expiry", membership_id: membershipA, language: "hi", body: "Hi" } });
    assert.equal(ok.nextCalled, true);
    assert.equal(ok.request.validatedMessage.membershipId, membershipA);
    assert.equal(ok.request.validatedMessage.channel, "wa_me");
    assert.equal(invoke(validateMessagePayload, { body: { reminder_type: "expiry" } }).nextCalled, false);
    assert.equal(invoke(validateMessagePayload, { body: { reminder_type: "welcome", membership_id: membershipA } }).nextCalled, false);
    assert.equal(invoke(validateMessagePayload, { body: { reminder_type: "expiry", membership_id: "not-a-uuid" } }).nextCalled, false);
    assert.equal(Object.hasOwn(invoke(validateMessagePayload, { body: { reminder_type: "welcome" } }).request.validatedMessage, "membershipId"), false);
});

test("the expiry reminder template allows only {name}, {plan} and {expiry_date}", () => {
    assert.equal(invoke(validateTemplateParams, { params: { key: "expiry_reminder", language: "mr" } }).nextCalled, true);
    const ok = invoke(validateTemplateBody, { params: { key: "expiry_reminder" }, body: { body: " Hi {name}, {plan} ends {expiry_date} " } });
    assert.equal(ok.request.validatedTemplateBody, "Hi {name}, {plan} ends {expiry_date}");
    const bad = invoke(validateTemplateBody, { params: { key: "expiry_reminder" }, body: { body: "Pay {balance}" } });
    assert.equal(bad.nextCalled, false);
    assert.match(bad.response.body.message, /balance/);
    // The welcome message keeps its own, larger set of placeholders.
    assert.equal(invoke(validateTemplateBody, { params: { key: "welcome" }, body: { body: "Fee {fee}" } }).nextCalled, true);
});

test("gym preferences are validated: language, date format, a 0-90 day window and on/off switches", () => {
    const ok = invoke(validateGymSettings, { body: { language: "hi", date_format: "DD/MM/YYYY", expiry_reminder_days: 10, payment_reminders: false, inactivity_reminders: true } });
    assert.equal(ok.nextCalled, true);
    assert.deepEqual(ok.request.validatedSettings, { language: "hi", date_format: "DD/MM/YYYY", expiry_reminder_days: 10, payment_reminders: false, inactivity_reminders: true });
    for (const [body, message] of [
        [{ language: "ta" }, /English, Hindi or Marathi/],
        [{ date_format: "MM/DD/YYYY" }, /DD MMM YYYY/],
        [{ expiry_reminder_days: 91 }, /0 to 90/],
        [{ expiry_reminder_days: 2.5 }, /0 to 90/],
        [{ payment_reminders: "yes" }, /on or off/],
        [{ currency: "USD" }, /only/]
    ]) {
        const result = invoke(validateGymSettings, { body });
        assert.equal(result.nextCalled, false, JSON.stringify(body));
        assert.match(result.response.body.message, message);
    }
});

test("the one-time move accepts only known fields, drops a broken message and dates future marks as now", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const ok = invoke(validateLocalDataImport, { body: {
        preferences: { language: "mr" },
        expiry_reminder_template: { language: "mr", body: "Hi {nickname}" },
        expiry_reminders: [{ membership_id: membershipA, end_date: "2026-11-20", sent_at: future }]
    } });
    assert.equal(ok.nextCalled, true);
    assert.equal(ok.request.localData.expiryReminderTemplate, null);
    assert.ok(Date.parse(ok.request.localData.expiryReminders[0].sent_at) <= Date.now());
    assert.equal(invoke(validateLocalDataImport, { body: { members: [] } }).nextCalled, false);
    assert.equal(invoke(validateLocalDataImport, { body: { expiry_reminders: [{ membership_id: "x", end_date: "2026-11-20", sent_at: future }] } }).nextCalled, false);
});

// ---------- Gym settings ----------

test("saving one setting leaves the others alone (a language change cannot erase the UPI ID)", async () => {
    const client = fakeClient({ gyms: [{ id: gymA, name: "Gym A" }], gym_settings: [{ gym_id: gymA, upi_id: "gym@okicici" }] });
    await saveGymSettings(gymA, { language: "hi" }, "owner", client);
    const upsert = client.calls.find((call) => call.table === "gym_settings" && call.operations.some(([method]) => method === "upsert"));
    const payload = upsert.operations.find(([method]) => method === "upsert")[1];
    assert.equal(payload.language, "hi");
    assert.equal(payload.gym_id, gymA);
    for (const key of ["upi_id", "phone", "address", "upi_payee_name"]) assert.equal(Object.hasOwn(payload, key), false, key);
});

test("settings answer with defaults for preferences the gym has not chosen", async () => {
    const client = fakeClient({ gyms: [{ id: gymA, name: "Gym A" }], gym_settings: [{ gym_id: gymA, language: "mr" }] });
    const settings = await getGymSettings(gymA, client);
    assert.equal(settings.language, "mr");
    assert.equal(settings.date_format, "DD MMM YYYY");
    assert.equal(settings.expiry_reminder_days, 7);
    assert.equal(settings.payment_reminders, true);
    assert.deepEqual(effectivePreferences({ expiry_reminder_days: 0, inactivity_reminders: false }), {
        language: "en", date_format: "DD MMM YYYY", expiry_reminder_days: 0, payment_reminders: true, inactivity_reminders: false
    });
});

test("the move fills only preferences the gym has not chosen yet", async () => {
    const client = fakeClient({ gym_settings: [{ gym_id: gymA, language: "mr", date_format: null }] });
    const filled = await fillUnsetPreferences(gymA, { language: "hi", date_format: "DD/MM/YYYY" }, "owner", client);
    assert.deepEqual(filled, ["date_format"]);
    const upsert = client.calls.find((call) => call.operations.some(([method]) => method === "upsert")).operations.find(([method]) => method === "upsert")[1];
    assert.equal(upsert.date_format, "DD/MM/YYYY");
    assert.equal(Object.hasOwn(upsert, "language"), false, "the gym's own choice is kept");
    assert.deepEqual(await fillUnsetPreferences(gymA, {}, "owner", fakeClient({ gym_settings: [] })), []);
});

test("sign-in reads the gym's language and date format, and never fails because of them", async () => {
    assert.deepEqual(await sessionPreferences(gymA, fakeClient({ gym_settings: [{ gym_id: gymA, language: "hi", date_format: "DD/MM/YYYY" }] })), { language: "hi", date_format: "DD/MM/YYYY" });
    const missingColumns = fakeClient({}, { errors: { gym_settings: { code: "42703" } } });
    assert.deepEqual(await sessionPreferences(gymA, missingColumns), { language: "en", date_format: "DD MMM YYYY" });
    assert.deepEqual(await sessionPreferences(gymA, { from() { throw new Error("down"); } }), { language: "en", date_format: "DD MMM YYYY" });
});

// ---------- Expiry reminders ----------

test("an expiry reminder is saved with the membership's end date read from the database", async () => {
    const client = fakeClient({
        members: [{ id: memberA, gym_id: gymA, whatsapp_opt_in: true, archived_at: null }],
        member_memberships: [{ id: membershipA, gym_id: gymA, member_id: memberA, end_date: "2026-11-20" }, { id: membershipB, gym_id: gymA, member_id: memberB, end_date: "2026-11-21" }]
    });
    const saved = await recordMemberMessage(memberA, { reminderType: "expiry", membershipId: membershipA, body: "Hi" }, gymA, client);
    assert.equal(saved.membership_id, membershipA);
    assert.equal(saved.membership_end_date, "2026-11-20");
    await assert.rejects(recordMemberMessage(memberA, { reminderType: "expiry", membershipId: membershipB }, gymA, client), (error) => error.status === 404);
    await assert.rejects(recordMemberMessage(memberA, { reminderType: "expiry", membershipId: membershipA }, gymB, client), (error) => error.status === 404);
});

test("a reminder counts only for the end date it was sent about; renewing starts unreminded", async () => {
    const client = fakeClient({ whatsapp_messages: [
        { gym_id: gymA, reminder_type: "expiry", membership_id: membershipA, membership_end_date: "2026-10-20", created_at: "2026-10-18T05:00:00Z" },
        { gym_id: gymA, reminder_type: "expiry", membership_id: membershipB, membership_end_date: "2026-11-21", created_at: "2026-11-19T05:00:00Z" },
        { gym_id: gymB, reminder_type: "expiry", membership_id: membershipA, membership_end_date: "2026-11-20", created_at: "2026-11-19T05:00:00Z" }
    ] });
    const reminded = await expiryRemindersFor([{ id: membershipA, end_date: "2026-11-20" }, { id: membershipB, end_date: "2026-11-21" }], gymA, client);
    assert.equal(reminded.has(membershipA), false, "the old end date and gym B's row do not count");
    assert.equal(reminded.get(membershipB), "2026-11-19T05:00:00Z");
    const beforeMigration = fakeClient({}, { errors: { whatsapp_messages: { code: "42703" } } });
    assert.equal((await expiryRemindersFor([{ id: membershipA, end_date: "2026-11-20" }], gymA, beforeMigration)).size, 0);
});

test("moving old \"Reminded\" marks keeps only this gym's consented members with the same end date", async () => {
    const consented = { id: memberA, whatsapp_opt_in: true, archived_at: null };
    const client = fakeClient({
        member_memberships: [
            { id: membershipA, gym_id: gymA, member_id: memberA, end_date: "2026-11-20", members: consented },
            { id: membershipB, gym_id: gymA, member_id: memberB, end_date: "2026-11-21", members: { id: memberB, whatsapp_opt_in: false, archived_at: null } }
        ],
        whatsapp_messages: []
    });
    const sentAt = "2026-11-18T06:00:00.000Z";
    const result = await importExpiryReminders([
        { membership_id: membershipA, end_date: "2026-11-20", sent_at: sentAt },
        { membership_id: membershipA, end_date: "2026-11-20", sent_at: sentAt },
        { membership_id: membershipA, end_date: "2026-10-01", sent_at: sentAt },
        { membership_id: membershipB, end_date: "2026-11-21", sent_at: sentAt },
        { membership_id: "00000000-0000-4000-8000-0000000000ff", end_date: "2026-11-20", sent_at: sentAt }
    ], "owner", gymA, client);
    assert.deepEqual(result, { moved: 1, skipped: 4 });
    const insert = client.calls.find((call) => call.table === "whatsapp_messages" && call.operations.some(([method]) => method === "insert")).operations.find(([method]) => method === "insert")[1];
    assert.deepEqual(insert, [{ gym_id: gymA, member_id: memberA, reminder_type: "expiry", channel: "wa_me", status: "sent", membership_id: membershipA, membership_end_date: "2026-11-20", sent_by: "owner", created_at: sentAt }]);
});

// ---------- Members: one current member per phone ----------

test("a phone number already used by another current member is refused with that member's name", async () => {
    const client = fakeClient({ members: [{ id: memberA, gym_id: gymA, full_name: "Riya Shah", phone: "9876543210", archived_at: null }] });
    await assert.rejects(assertPhoneAvailable("9876543210", gymA, {}, client), (error) => error.status === 409 && /Riya Shah/.test(error.message));
    await assertPhoneAvailable("9876543210", gymA, { exceptId: memberA }, client);
    await assertPhoneAvailable("9876543210", gymB, {}, client);
    await assertPhoneAvailable("9876543211", gymA, {}, client);
});

test("the database's unique phone index is reported as a duplicate phone, not retried as a member code", async () => {
    const client = fakeClient({}, { errors: { members: { code: "23505", message: 'duplicate key value violates unique constraint "members_gym_phone_key"' } } });
    await assert.rejects(createMember({ full_name: "Dev Rao", phone: "9876543210", status: "active" }, gymA, client), (error) => error.status === 409 && /phone number already belongs/.test(error.message));
    assert.equal(client.calls.filter((call) => call.table === "members").length, 1);
});

// ---------- Gym totals ----------

test("gym totals come from one database call and money is rounded to paise", async () => {
    let called;
    const client = { rpc: async (name, args) => { called = [name, args]; return { data: { total_members: 212, outstanding_total: "1200.505", collected_this_month: 950, collected_all_time: 1000.1, months: [{ month: "2026-11", collected: "10.004", outstanding: 5 }] }, error: null }; } };
    const summary = await getGymSummary(gymA, { months: 6 }, client);
    assert.deepEqual(called, ["gympulse_gym_summary", { p_gym_id: gymA, p_months: 6 }]);
    assert.equal(summary.total_members, 212);
    assert.equal(summary.outstanding_total, 1200.51);
    assert.equal(summary.months[0].collected, 10);
    assert.deepEqual(summary.active_by_plan, []);
    await assert.rejects(getGymSummary(gymA, {}, { rpc: async () => ({ data: null, error: { code: "PGRST202" } }) }), (error) => error.status === 503 && /015/.test(error.message));
    await assert.rejects(getGymSummary(null, {}, client), (error) => error.status === 403);
});

// ---------- Browser rules without a DOM ----------

test("the reminder message fills its three placeholders and has defaults in every language", () => {
    assert.equal(buildReminderMessage("Hi {name}, {plan} ends {expiry_date}. {gym_name}", { name: "Riya", plan: "Monthly", expiry_date: "20 Nov 2026" }), "Hi Riya, Monthly ends 20 Nov 2026. {gym_name}");
    for (const language of ["en", "hi", "mr"]) assert.equal(reminderTemplateProblem(DEFAULT_REMINDER_TEMPLATES[language]), "", language);
    assert.match(reminderTemplateProblem(""), /Enter/);
    assert.match(reminderTemplateProblem("x".repeat(1001)), /1000/);
});

test("CSV cells that a spreadsheet would run as a formula are kept as text; numbers stay numbers", () => {
    assert.equal(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
    assert.equal(csvCell("+919876543210"), "\"'+919876543210\"");
    assert.equal(csvCell("@sum"), "\"'@sum\"");
    assert.equal(csvCell(-250), "\"-250\"");
    assert.equal(csvCell("Riya Shah"), "\"Riya Shah\"");
    assert.equal(csvCell(null), "\"\"");
});

test("a check-in's day is the India date: a 5:15 am check-in is not counted as yesterday", () => {
    assert.equal(visitDay({ checkedInAt: "2026-11-14T23:45:00.000Z" }), "2026-11-15");
    assert.equal(visitDay({ checkedInAt: "2026-11-14T23:45:00.000Z", checkInDate: "2026-11-15" }), "2026-11-15");
    assert.equal(visitDay({ checkedInAt: "not a date" }), "");
});

test("the language lives in memory; blocked browser storage cannot break the app", () => {
    setLanguage("hi");
    assert.equal(getLanguage(), "hi");
    assert.throws(() => setLanguage("ta"));
    assert.equal(getLanguage(), "hi");
    setLanguage("en");
    assert.equal(readSavedWorkspace("owner"), null);
    assert.deepEqual(readUiPreferences(), {});
    assert.doesNotThrow(() => saveUiPreferences({ view: "members" }));
});

test("members carry the server's fees and payments, never a hard-coded zero", () => {
    const member = memberFromApiRow({ id: memberA, member_code: "GP-1", full_name: "Riya", billing: { billed: 1800, paid: 500, outstanding: 1300 }, current_membership: { id: membershipA, plan_id: "p", start_date: "2026-11-01", end_date: "2026-11-30", total_fees: 1800 } });
    assert.equal(member.totalFees, 1800);
    assert.equal(member.paidTotal, 500);
    assert.equal(member.expiryDate, "2026-11-30");
    for (const key of ["charges", "amountPaid", "renewals"]) assert.equal(Object.hasOwn(member, key), false, key);
});

test("the one-time move lists what an older version saved, and skips copies of database members", () => {
    const saved = {
        gym: { name: "My Gym", phone: "98230 12345", address: "", dateFormat: "DD/MM/YYYY", preferences: { expiryReminderDays: 10, paymentReminders: true, inactivityReminders: false } },
        whatsapp: { expiryReminderTemplate: "नमस्ते {name}, {plan} {expiry_date}" },
        expiryReminders: { [`${membershipA}:2026-11-20`]: "2026-11-18T06:00:00.000Z", "GP-OLD:2026-11-20": "2026-11-18T06:00:00.000Z", [`${membershipB}:soon`]: "x" },
        attendance: [{ memberId: memberA, checkedInAt: "2026-10-01T03:00:00Z" }, { memberId: "GP-1001", checkedInAt: "2026-10-01T03:00:00Z" }],
        members: [{ id: memberA, memberCode: "GP-ABC", name: "Database copy" }, { id: "GP-9", name: "Old Local", phone: "9876500000", renewals: [{ date: "2026-01-01", amount: 900 }] }],
        payments: [{ id: "TX-1", memberId: "GP-9", amount: 900, date: "2026-01-01", method: "Cash" }, { id: membershipA, amount: 1 }]
    };
    const data = collectLocalData(saved, { legacyLanguage: "hi" });
    assert.deepEqual(data.preferences, { date_format: "DD/MM/YYYY", language: "hi", expiry_reminder_days: 10, inactivity_reminders: false });
    assert.deepEqual(data.reminderTemplate, { language: "hi", body: "नमस्ते {name}, {plan} {expiry_date}" });
    assert.deepEqual(data.reminders, [{ membership_id: membershipA, end_date: "2026-11-20", sent_at: "2026-11-18T06:00:00.000Z" }]);
    assert.equal(data.checkIns, 1);
    assert.deepEqual(data.contact, { phone: "98230 12345", address: "" });
    assert.deepEqual(data.oldRecords.map((row) => [row.record, row.id]), [["member", "GP-9"], ["payment", "TX-1"], ["renewal", "GP-9"]]);
    assert.equal(data.any, true);

    // Only copies of database members and default settings: nothing to move, so it is deleted.
    const copies = collectLocalData({ gym: { name: "My Gym", dateFormat: "DD MMM YYYY", preferences: { expiryReminderDays: 7 } }, members: [{ id: memberA, memberCode: "GP-ABC" }], whatsapp: { expiryReminderTemplate: DEFAULT_REMINDER_TEMPLATES.en } });
    assert.equal(copies.any, false);
    assert.equal(collectLocalData(null), null);
});
