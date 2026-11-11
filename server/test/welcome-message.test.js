import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_WELCOME_TEMPLATES,
    WELCOME_PLACEHOLDERS,
    buildWelcomeMessage,
    paymentPlaceholderValues,
    welcomePayment,
    welcomeTemplateProblem,
    welcomeWhatsAppUrl
} from "../../assets/js/welcomeMessage.js";
import { formatINR } from "../../assets/js/utils.js";
import { listMemberMessages, listTemplates, recordMemberMessage, saveTemplate } from "../services/whatsappMessagesService.js";
import { validateMessagePayload, validateTemplateBody, validateTemplateParams } from "../middleware/validateWhatsAppMessage.js";

// welcome.js reads the saved language and browser state through localStorage.
const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
const { sendWelcome, welcomeBlocker, welcomeFacts, welcomeValues } = await import("../../assets/js/modules/welcome.js");

const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
const memberId = "00000000-0000-4000-8000-000000000001";

const fullValues = {
    name: "Riya Shah",
    gym_name: "Iron Temple",
    plan: "Quarterly",
    start_date: "12 Nov 2026",
    expiry_date: "10 Feb 2027",
    member_code: "GP-ABC123",
    gym_phone: "98230 12345",
    gym_address: "FC Road, Pune",
    fee: "₹1,100",
    amount_paid: "₹500 (UPI)",
    balance: "₹600"
};

// ---------- Template filling ----------

test("the English default fills every placeholder, including fee, paid and balance", () => {
    assert.equal(buildWelcomeMessage(DEFAULT_WELCOME_TEMPLATES.en, fullValues), [
        "Hi Riya Shah, welcome to Iron Temple! 💪",
        "Your Quarterly membership is active from 12 Nov 2026 to 10 Feb 2027.",
        "Fee: ₹1,100.",
        "Paid: ₹500 (UPI).",
        "Balance due: ₹600.",
        "Member ID: GP-ABC123.",
        "For any help, call us at 98230 12345.",
        "See you at the gym!"
    ].join("\n"));
});

test("a custom template can use all eleven placeholders, each more than once", () => {
    assert.equal(WELCOME_PLACEHOLDERS.length, 11);
    const template = `${WELCOME_PLACEHOLDERS.map((key) => `{${key}}`).join(" | ")}\n{name} owes {balance}`;
    assert.equal(
        buildWelcomeMessage(template, fullValues),
        "Riya Shah | Iron Temple | Quarterly | 12 Nov 2026 | 10 Feb 2027 | GP-ABC123 | 98230 12345 | FC Road, Pune | ₹1,100 | ₹500 (UPI) | ₹600\nRiya Shah owes ₹600"
    );
});

test("lines whose placeholder has no value are left out, and blank lines do not pile up", () => {
    const noPhone = buildWelcomeMessage(DEFAULT_WELCOME_TEMPLATES.en, { ...fullValues, gym_phone: "" });
    assert.doesNotMatch(noPhone, /call us/);
    assert.match(noPhone, /See you at the gym!$/);
    assert.equal(noPhone.split("\n").length, 7);

    // Fully paid: no balance line. Nothing paid yet: no paid or balance line. Fee unknown: none of the three.
    const fullyPaid = buildWelcomeMessage(DEFAULT_WELCOME_TEMPLATES.en, { ...fullValues, amount_paid: "₹1,100 (UPI)", balance: "" });
    assert.match(fullyPaid, /Fee: ₹1,100\.\nPaid: ₹1,100 \(UPI\)\.\nMember ID/);
    const unpaid = buildWelcomeMessage(DEFAULT_WELCOME_TEMPLATES.en, { ...fullValues, amount_paid: "", balance: "" });
    assert.match(unpaid, /Fee: ₹1,100\.\nMember ID/);
    const noFee = buildWelcomeMessage(DEFAULT_WELCOME_TEMPLATES.en, { ...fullValues, fee: "", amount_paid: "", balance: "" });
    assert.doesNotMatch(noFee, /Fee|Paid|Balance/);

    // Whitespace-only and missing keys count as empty too.
    const sparse = buildWelcomeMessage(DEFAULT_WELCOME_TEMPLATES.en, { name: "Dev", gym_name: "Iron Temple", gym_phone: "   " });
    assert.equal(sparse, "Hi Dev, welcome to Iron Temple! 💪\nSee you at the gym!");

    const withAddress = "Hi {name}!\n\nVisit us at {gym_address}.\n\nCall {gym_phone}.\n\nThanks";
    assert.equal(buildWelcomeMessage(withAddress, { name: "Dev" }), "Hi Dev!\n\nThanks");
    assert.equal(buildWelcomeMessage("Call {gym_phone}", {}), "");
    assert.equal(buildWelcomeMessage("Hi {name}\r\nBye", { name: "Dev" }), "Hi Dev\nBye");
    // The user's one-line style works too: the whole line goes when any of its values is empty.
    assert.equal(buildWelcomeMessage("Fee: {fee}. Paid: {amount_paid}. Balance: {balance}.", fullValues), "Fee: ₹1,100. Paid: ₹500 (UPI). Balance: ₹600.");
    assert.equal(buildWelcomeMessage("Fee: {fee}. Paid: {amount_paid}. Balance: {balance}.", { ...fullValues, balance: "" }), "");
});

test("the Hindi and Marathi defaults fill in Devanagari text, with fee lines", () => {
    const values = { ...fullValues, name: "प्रिया देशमुख", plan: "मासिक" };
    assert.equal(buildWelcomeMessage(DEFAULT_WELCOME_TEMPLATES.hi, values), [
        "नमस्ते प्रिया देशमुख, Iron Temple में आपका स्वागत है! 💪",
        "आपकी मासिक सदस्यता 12 Nov 2026 से 10 Feb 2027 तक सक्रिय है।",
        "शुल्क: ₹1,100",
        "भुगतान: ₹500 (UPI)",
        "बकाया राशि: ₹600",
        "सदस्य आईडी: GP-ABC123",
        "किसी भी मदद के लिए हमें 98230 12345 पर कॉल करें।",
        "जिम में मिलते हैं!"
    ].join("\n"));
    assert.equal(buildWelcomeMessage(DEFAULT_WELCOME_TEMPLATES.mr, { ...values, gym_phone: "", balance: "" }), [
        "नमस्कार प्रिया देशमुख, Iron Temple मध्ये आपले स्वागत आहे! 💪",
        "आपले मासिक सदस्यत्व 12 Nov 2026 पासून 10 Feb 2027 पर्यंत सक्रिय आहे.",
        "शुल्क: ₹1,100",
        "भरलेली रक्कम: ₹500 (UPI)",
        "सदस्य आयडी: GP-ABC123",
        "जिममध्ये भेटूया!"
    ].join("\n"));
});

test("templates are checked for unknown placeholders and length; the defaults pass", () => {
    for (const body of Object.values(DEFAULT_WELCOME_TEMPLATES)) assert.equal(welcomeTemplateProblem(body), "");
    for (const key of ["fee", "amount_paid", "balance"]) assert.equal(welcomeTemplateProblem(`x {${key}}`), "");
    assert.match(welcomeTemplateProblem("Hi {first_name}"), /Unsupported placeholder: \{first_name\}/);
    assert.match(welcomeTemplateProblem("Hi {}"), /Unsupported placeholder/);
    assert.match(welcomeTemplateProblem("   "), /Enter a welcome message/);
    assert.match(welcomeTemplateProblem("a".repeat(1001)), /1000 characters/);
    // An unknown placeholder is never silently dropped when filling.
    assert.equal(buildWelcomeMessage("Hi {first_name}", fullValues), "Hi {first_name}");
});

test("the wa.me link uses the 10-digit number with 91 and encodes the message", () => {
    assert.equal(welcomeWhatsAppUrl("+919876543210", "Hi Riya & co\nLine 2 💪"), "https://wa.me/919876543210?text=Hi%20Riya%20%26%20co%0ALine%202%20%F0%9F%92%AA");
    assert.equal(welcomeWhatsAppUrl("9876543210", "x"), "https://wa.me/919876543210?text=x");
    assert.throws(() => welcomeWhatsAppUrl("12345", "x"), /valid Indian mobile/);
});

// ---------- Fee, paid and balance ----------

const membershipRow = { id: "ms-1", plan_name: "Monthly", price: 1100, total_fees: 1100, start_date: "2026-11-12", end_date: "2026-12-11" };

test("fee, paid and balance come from the membership and only its own payments", () => {
    const payments = [
        { membership_id: "ms-1", amount: "500.00", method: "upi" },
        { membership_id: "ms-old", amount: 9999, method: "cash" },
        { membership_id: null, amount: 50, method: "cash" }
    ];
    assert.deepEqual(welcomePayment(membershipRow, payments), { fee: 1100, paid: 500, balance: 600, methods: ["UPI"], hasPayment: true });
    assert.deepEqual(paymentPlaceholderValues(welcomePayment(membershipRow, payments), formatINR), { fee: "₹1,100", amount_paid: "₹500 (UPI)", balance: "₹600" });

    // Fully paid (split over two methods): no balance.
    const full = welcomePayment(membershipRow, [{ membership_id: "ms-1", amount: 600, method: "upi" }, { membership_id: "ms-1", amount: 500, method: "cash" }]);
    assert.deepEqual(paymentPlaceholderValues(full, formatINR), { fee: "₹1,100", amount_paid: "₹1,100 (UPI, Cash)", balance: "" });
    // Nothing paid: fee only.
    assert.deepEqual(paymentPlaceholderValues(welcomePayment(membershipRow, []), formatINR), { fee: "₹1,100", amount_paid: "", balance: "" });
    // Overpaid never shows a negative balance.
    assert.equal(welcomePayment(membershipRow, [{ membership_id: "ms-1", amount: 1500, method: "card" }]).balance, 0);
    // The billed fee wins over the plan price; the plan price is the fallback.
    assert.equal(welcomePayment({ ...membershipRow, total_fees: 900 }, []).fee, 900);
    assert.equal(welcomePayment({ ...membershipRow, total_fees: null }, []).fee, 1100);
    // No membership or no fee: nothing, so every fee line is left out.
    assert.equal(welcomePayment(null, []), null);
    assert.equal(welcomePayment({ id: "x" }, []), null);
    assert.deepEqual(paymentPlaceholderValues(null, formatINR), { fee: "", amount_paid: "", balance: "" });
});

test("amounts use Indian digit grouping", () => {
    assert.deepEqual(paymentPlaceholderValues(welcomePayment({ id: "big", total_fees: 125000 }, [{ membership_id: "big", amount: 25000, method: "card" }]), formatINR), {
        fee: "₹1,25,000", amount_paid: "₹25,000 (Card)", balance: "₹1,00,000"
    });
});

// ---------- sendWelcome: consent is required ----------

const member = {
    id: memberId, name: "Riya Shah", phone: "9876543210", memberCode: "GP-ABC123", whatsappOptIn: true,
    currentMembership: { plan_name: "Quarterly", start_date: "2026-11-12", end_date: "2027-02-10" }
};
const gym = { name: "Iron Temple", phone: "", address: "" };

test("sendWelcome refuses members without WhatsApp consent and opens nothing", () => {
    const opened = [];
    const recorded = [];
    for (const candidate of [{ ...member, whatsappOptIn: false }, { ...member, whatsappOptIn: undefined }]) {
        assert.equal(welcomeBlocker(candidate), "no-consent");
        assert.throws(
            () => sendWelcome(candidate, { gym, open: (url) => opened.push(url), record: (...args) => recorded.push(args) }),
            /not agreed to receive WhatsApp updates/
        );
    }
    assert.throws(() => sendWelcome({ ...member, phone: "123" }, { gym, open: (url) => opened.push(url), record: () => {} }), /valid Indian mobile/);
    assert.deepEqual(opened, []);
    assert.deepEqual(recorded, []);
});

test("sendWelcome opens WhatsApp synchronously, then logs the welcome in the chosen language", async () => {
    const calls = [];
    const pending = sendWelcome(member, {
        gym,
        language: "mr",
        open: (url) => calls.push(["open", url]),
        record: async (id, payload) => { calls.push(["record", id, payload]); return { id: "log-1" }; }
    });
    // WhatsApp was opened before sendWelcome returned, i.e. without waiting on anything.
    assert.equal(calls[0][0], "open");
    const url = new URL(calls[0][1]);
    assert.equal(url.origin + url.pathname, "https://wa.me/919876543210");
    const text = url.searchParams.get("text");
    assert.match(text, /^नमस्कार Riya Shah, Iron Temple मध्ये आपले स्वागत आहे!/);
    assert.doesNotMatch(text, /कॉल करा/, "no gym phone, so the call line is left out");
    assert.doesNotMatch(text, /शुल्क/, "fee not loaded, so the fee lines are left out");
    assert.deepEqual(await pending, { id: "log-1" });
    assert.deepEqual(calls[1], ["record", memberId, { reminder_type: "welcome", language: "mr", body: text }]);
});

test("welcome values come from the member, their membership and the gym", () => {
    const values = welcomeValues(member, { gym: { name: "Iron Temple", phone: "98230 12345", address: "FC Road" } });
    assert.deepEqual(values, {
        name: "Riya Shah", gym_name: "Iron Temple", plan: "Quarterly", start_date: "12 Nov 2026", expiry_date: "10 Feb 2027",
        member_code: "GP-ABC123", gym_phone: "98230 12345", gym_address: "FC Road", fee: "", amount_paid: "", balance: ""
    });
    // No membership yet: dates stay empty (not "—") so their line is left out.
    const bare = welcomeValues({ ...member, currentMembership: null }, { gym });
    assert.equal(bare.start_date, "");
    assert.equal(bare.plan, "");
});

test("fee values use the database membership and payments, not the browser's copy", () => {
    const stale = { ...membershipRow, total_fees: 1, price: 1 };
    welcomeFacts[memberId] = { status: "ready", memberships: [membershipRow], payments: [{ membership_id: "ms-1", amount: 1100, method: "upi" }] };
    try {
        const values = welcomeValues({ ...member, currentMembership: stale }, { gym });
        assert.deepEqual([values.fee, values.amount_paid, values.balance], ["₹1,100", "₹1,100 (UPI)", ""]);
        const opened = [];
        sendWelcome({ ...member, currentMembership: stale }, { gym, language: "en", open: (url) => opened.push(url), record: async () => ({}) });
        const text = new URL(opened[0]).searchParams.get("text");
        assert.match(text, /Fee: ₹1,100\.\nPaid: ₹1,100 \(UPI\)\.\nMember ID/);
        assert.doesNotMatch(text, /Balance/);
    } finally {
        delete welcomeFacts[memberId];
    }
});

// ---------- Service: consent and gym isolation of the welcome log ----------

function mockClient(tables = {}) {
    const calls = [];
    const client = {
        calls,
        from(table) {
            const call = { table, operations: [] };
            calls.push(call);
            const query = {};
            for (const method of ["select", "eq", "is", "order", "insert", "upsert", "delete"]) {
                query[method] = (...args) => { call.operations.push([method, ...args]); return query; };
            }
            const filters = () => call.operations.filter(([method]) => method === "eq").map(([, field, value]) => [field, value]);
            const rows = () => (tables[table] || []).filter((row) => filters().every(([field, value]) => row[field] === value));
            const written = () => call.operations.find(([method]) => method === "insert" || method === "upsert")?.[1];
            query.maybeSingle = () => Promise.resolve({ data: rows()[0] || null, error: null });
            query.single = () => Promise.resolve({ data: { id: "new", ...written() }, error: null });
            query.then = (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
            return query;
        }
    };
    return client;
}

test("logging a welcome requires the member's WhatsApp consent", async () => {
    const client = mockClient({ members: [{ id: memberId, gym_id: gymA, whatsapp_opt_in: false }] });
    await assert.rejects(recordMemberMessage(memberId, { reminderType: "welcome" }, gymA, client), (error) => error.status === 409);
    assert.equal(client.calls.some((call) => call.table === "whatsapp_messages"), false);

    const consented = mockClient({ members: [{ id: memberId, gym_id: gymA, whatsapp_opt_in: true }] });
    const saved = await recordMemberMessage(memberId, { reminderType: "welcome", language: "hi", body: "नमस्ते", sentBy: "owner-a" }, gymA, consented);
    assert.deepEqual(saved, {
        id: "new", gym_id: gymA, member_id: memberId, reminder_type: "welcome", channel: "wa_me", status: "sent", language: "hi", body: "नमस्ते", sent_by: "owner-a"
    });
});

test("gym A can neither log nor read welcomes for gym B's member", async () => {
    const tables = {
        members: [{ id: memberId, gym_id: gymB, whatsapp_opt_in: true }],
        whatsapp_messages: [{ id: "m1", gym_id: gymB, member_id: memberId, reminder_type: "welcome" }]
    };
    const client = mockClient(tables);
    await assert.rejects(recordMemberMessage(memberId, { reminderType: "welcome" }, gymA, client), (error) => error.status === 404);
    await assert.rejects(listMemberMessages(memberId, { reminderType: "welcome" }, gymA, client), (error) => error.status === 404);
    assert.equal(client.calls.some((call) => call.table === "whatsapp_messages"), false);
    await assert.rejects(listMemberMessages(memberId, {}, null, client), (error) => error.status === 403);

    const own = mockClient({
        members: [{ id: memberId, gym_id: gymA, whatsapp_opt_in: true }],
        whatsapp_messages: [
            { id: "a1", gym_id: gymA, member_id: memberId, reminder_type: "welcome" },
            { id: "b1", gym_id: gymB, member_id: memberId, reminder_type: "welcome" },
            { id: "a2", gym_id: gymA, member_id: memberId, reminder_type: "expiry" }
        ]
    });
    assert.deepEqual((await listMemberMessages(memberId, { reminderType: "welcome" }, gymA, own)).map((row) => row.id), ["a1"]);
    const query = own.calls.find((call) => call.table === "whatsapp_messages");
    assert.ok(query.operations.some(([method, field, value]) => method === "eq" && field === "gym_id" && value === gymA));
});

test("welcome templates are read and saved per gym", async () => {
    const client = mockClient({ gym_message_templates: [{ gym_id: gymA, template_key: "welcome", language: "hi", body: "A" }, { gym_id: gymB, template_key: "welcome", language: "hi", body: "B" }] });
    assert.deepEqual((await listTemplates("welcome", gymA, client)).map((row) => row.body), ["A"]);
    const saved = await saveTemplate("welcome", "mr", "Hi {name}", "owner-a", gymA, client);
    assert.equal(saved.gym_id, gymA);
    assert.equal(saved.language, "mr");
    const upsert = client.calls.at(-1).operations.find(([method]) => method === "upsert");
    assert.deepEqual(upsert[2], { onConflict: "gym_id,template_key,language" });
});

// ---------- Request validation ----------

function invoke(middleware, request) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    let nextCalled = false;
    middleware(request, response, () => { nextCalled = true; });
    return { response, nextCalled, request };
}

test("the browser can only log a wa.me send; it cannot pick the channel, status or gym", () => {
    const ok = invoke(validateMessagePayload, { body: { reminder_type: "welcome", language: "en", body: "Hi" } });
    assert.equal(ok.nextCalled, true);
    assert.deepEqual(ok.request.validatedMessage, { reminderType: "welcome", channel: "wa_me", status: "sent", language: "en", body: "Hi" });
    for (const body of [{}, { reminder_type: "hello" }, { reminder_type: "welcome", channel: "cloud_api" }, { reminder_type: "welcome", status: "delivered" }, { reminder_type: "welcome", gym_id: gymB }, { reminder_type: "welcome", language: "fr" }]) {
        assert.equal(invoke(validateMessagePayload, { body }).nextCalled, false, JSON.stringify(body));
    }
});

test("saved templates must use known placeholders and a supported language", () => {
    assert.equal(invoke(validateTemplateBody, { body: { body: " Hi {name} " } }).request.validatedTemplateBody, "Hi {name}");
    const bad = invoke(validateTemplateBody, { body: { body: "Hi {nickname}" } });
    assert.equal(bad.nextCalled, false);
    assert.match(bad.response.body.message, /nickname/);
    assert.equal(invoke(validateTemplateBody, { body: { body: "Hi", gym_id: gymB } }).nextCalled, false);
    assert.equal(invoke(validateTemplateParams, { params: { key: "welcome", language: "hi" } }).nextCalled, true);
    assert.equal(invoke(validateTemplateParams, { params: { key: "welcome", language: "ta" } }).nextCalled, false);
    assert.equal(invoke(validateTemplateParams, { params: { key: "promo", language: "en" } }).nextCalled, false);
});
