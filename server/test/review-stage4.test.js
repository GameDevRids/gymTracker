// Stage 4 of the live-app review: one Add member form for the desk. Field order, Paid in full / Part
// payment / Not yet with correct balances, More details closed, the member's own WhatsApp consent step
// (migration 026, source member_desk) and the actions offered after saving.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installPhotoDom } from "./helpers/fakeDom.js";
import { createMigratedDatabase } from "./helpers/database.js";
import { validateConsentPayload } from "../middleware/validateMember.js";

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const boot = installPhotoDom();
const { PHONE_HELP, addMemberFieldsHtml, addedActions, consentStepHtml, memberConsentQuestion, paymentNow } = await import("../../assets/js/modules/addMember.js");
boot.restore();

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const main = source("assets/js/main.js");

// ---------- Paid in full / Part payment / Not yet ----------

test("Paid in full records the whole fee and leaves nothing due", () => {
    assert.deepEqual(paymentNow({ choice: "full", fee: "1500" }), { amount: 1500, balance: 0, problem: "" });
});

test("Part payment records the amount and leaves the rest due", () => {
    assert.deepEqual(paymentNow({ choice: "part", fee: 1500, part: "500" }), { amount: 500, balance: 1000, problem: "" });
    assert.match(paymentNow({ choice: "part", fee: 1500, part: "" }).problem, /Enter the amount paid now/);
    assert.match(paymentNow({ choice: "part", fee: 1500, part: "0" }).problem, /Enter the amount paid now/);
    assert.match(paymentNow({ choice: "part", fee: 1500, part: "1500" }).problem, /Paid in full/, "the whole fee is not a part payment");
});

test("Not yet records no payment and the whole fee is due; a free plan records nothing", () => {
    assert.deepEqual(paymentNow({ choice: "none", fee: 1500 }), { amount: 0, balance: 1500, problem: "" });
    assert.deepEqual(paymentNow({ choice: "full", fee: 0 }), { amount: 0, balance: 0, problem: "" });
    assert.match(paymentNow({ choice: "full", fee: "-1" }).problem, /Enter the fee/);
});

test("the payment saved with a new member uses the chosen method and amount", () => {
    assert.match(main, /const payNow = isNewMember \? formPayment\(form\)/);
    assert.match(main, /amount: initialPayment,[\s\S]{0,80}method: payNow\.method/);
    assert.doesNotMatch(main, /method: "upi",\s*note: "Initial payment"/, "no longer always UPI");
});

// ---------- One form, in desk order ----------

const html = addMemberFieldsHtml({ nameField: `<div class="field"><input id="form-name" name="name"></div>`, planField: `<select id="form-planId" name="planId"></select>`, photoField: `<div class="photo-field"></div>`, expiryPlaceholder: "Choose a plan" });

test("Add member: name, phone, plan, expiry, start date, fee, payment, then More details", () => {
    const order = ['id="form-name"', 'id="form-phone"', 'id="form-planId"', 'id="form-expiry-text"', 'id="form-assignmentStartDate"', 'id="form-totalFees"', 'name="paymentChoice"', 'name="paymentMethod"', 'id="add-qr-button"', 'id="add-more-details"'].map((needle) => html.indexOf(needle));
    assert.ok(order.every((index) => index >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.deepEqual([...html.matchAll(/name="paymentChoice" value="(\w+)"( checked)?/g)].map((m) => [m[1], Boolean(m[2])]), [["full", true], ["part", false], ["none", false]]);
    assert.deepEqual([...html.matchAll(/name="paymentMethod" value="(\w+)"/g)].map((m) => m[1]), ["upi", "cash", "card", "other"]);
    assert.match(html, />Show UPI QR</);
});

test("More details is closed and holds email, date of birth, gender, emergency contact, notes and photo", () => {
    assert.match(html, /<details class="field full more-details" id="add-more-details"><summary>More details<\/summary>/, "no open attribute");
    const details = html.slice(html.indexOf("<details"));
    for (const name of ["email", "dob", "gender", "emergencyContact", "notes"]) assert.match(details, new RegExp(`name="${name}"`), name);
    assert.match(details, /photo-field/);
    assert.doesNotMatch(html.slice(0, html.indexOf("<details")), /name="(email|dob|gender|emergencyContact|notes)"/);
});

test("the phone field carries 'Each member needs their own phone number'; no staff consent checkbox", () => {
    assert.equal(PHONE_HELP, "Each member needs their own phone number.");
    assert.match(html, /id="form-phone-help" class="helper-text">Each member needs their own phone number\.</);
    assert.doesNotMatch(html, /whatsappOptIn/);
    assert.equal((html.match(/autocomplete="off"/g) || []).length >= 8, true, "autofill off on the fields");
});

test("Quick add is gone everywhere", () => {
    for (const path of ["assets/js/main.js", "assets/js/modules/members.js", "assets/js/modules/dashboard.js", "assets/js/i18n.js"]) {
        assert.doesNotMatch(source(path), /quick-add|quick-member-form|quickAdd|Quick add/, path);
    }
});

// ---------- The member's own consent ----------

test("the consent step is for the member to read and tap", () => {
    assert.equal(memberConsentQuestion("Iron Den"), "Iron Den may send you WhatsApp messages about your membership.");
    const step = consentStepHtml({ gymName: "Iron Den", memberName: "Riya" });
    assert.equal(step.title, "Hand the phone to the member");
    assert.match(step.footer, /data-member-consent="no">No thanks</);
    assert.match(step.footer, /data-member-consent="yes">I agree</);
});

test("I agree is recorded with source member_desk; enquiry consent is kept and not asked again", () => {
    assert.match(main, /setWhatsAppConsentOnApi\(memberId, true, "member_desk"\)/);
    assert.match(main, /else if \(form\.dataset\.enquiryConsent === "true"\) await recordFormConsent\(saved\.id, true, "enquiry"\)/);
    assert.match(main, /if \(member && member\.whatsappOptIn !== true\) \{\s*const stillOpen = await askMemberConsent/);
    const result = (body) => {
        const request = { body };
        let status = 200;
        const response = { status(code) { status = code; return { json() {} }; } };
        validateConsentPayload(request, response, () => {});
        return { status, consent: request.validatedConsent };
    };
    assert.deepEqual(result({ opt_in: true, source: "member_desk" }).consent, { optIn: true, source: "member_desk" });
    assert.equal(result({ opt_in: true, source: "someone_else" }).status, 400);
    assert.match(source("server/services/membersService.js"), /"member_desk"\]\)/);
    assert.match(source("assets/js/modules/members.js"), /member_desk: "Member agreed at the desk"/);
});

// ---------- Migration 026 in real Postgres ----------

const owner = "00000000-0000-4000-8000-00000000000a";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
let db;
before(async () => {
    db = await createMigratedDatabase();
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${owner}', 'a@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'Gym A', '${owner}'), ('${gymB}', 'Gym B', '${owner}');
    `);
});

const addMemberRow = async (gymId, phone) => (await db.query("INSERT INTO public.members (gym_id, member_code, full_name, phone) VALUES ($1, $2, 'Riya Shah', $3) RETURNING id", [gymId, `GP-${phone}`, phone])).rows[0].id;
const consent = (gymId, memberId, source) => db.query("SELECT * FROM public.gympulse_set_member_whatsapp_consent($1, $2, true, $3, $4)", [gymId, memberId, source, owner]);

test("migration 026: member_desk consent is saved with one history event", async () => {
    const id = await addMemberRow(gymA, "9876500101");
    const { rows } = await consent(gymA, id, "member_desk");
    assert.equal(rows[0].whatsapp_opt_in, true);
    const history = (await db.query("SELECT channel, action, source, recorded_by FROM public.member_consent_events WHERE member_id = $1", [id])).rows;
    assert.deepEqual(history, [{ channel: "whatsapp", action: "granted", source: "member_desk", recorded_by: owner }]);
});

test("migration 026: other sources still work, unknown ones are refused, and gyms stay separate", async () => {
    const id = await addMemberRow(gymA, "9876500102");
    await assert.rejects(consent(gymA, id, "desk"), /Unknown consent source/, "photo's source is not a WhatsApp source");
    await assert.rejects(consent(gymB, id, "member_desk"), /Member not found/, "another gym cannot record it");
    assert.equal((await consent(gymA, id, "enquiry")).rows[0].whatsapp_opt_in, true);
    await assert.rejects(db.query("INSERT INTO public.member_consent_events (gym_id, member_id, channel, action, source) VALUES ($1, $2, 'photo', 'granted', 'member_desk')", [gymA, id]), /member_consent_events_source_valid|violates/);
});

// ---------- After saving ----------

test("after saving: Send welcome card with consent, Send receipt when paid", () => {
    const paid = addedActions({ memberId: "m1", canWelcome: true, paymentId: "p1", paid: 1500, balance: 0 });
    assert.match(paid.footer, /data-action="welcome-share-card" data-id="m1">Send welcome card</);
    assert.match(paid.footer, /data-action="receipt" data-id="p1">Send receipt</);
    assert.match(paid.body, /₹1,500 received/);
    const unpaid = addedActions({ memberId: "m1", canWelcome: false, paid: 0, balance: 1500 });
    assert.doesNotMatch(unpaid.footer, /Send welcome card|Send receipt/);
    assert.match(unpaid.body, /₹1,500 is due/);
    assert.match(unpaid.body, /No WhatsApp consent/);
    const part = addedActions({ memberId: "m1", canWelcome: true, paymentId: "p2", paid: 500, balance: 1000 });
    assert.match(part.body, /₹500 received · ₹1,000 still due/);
});
