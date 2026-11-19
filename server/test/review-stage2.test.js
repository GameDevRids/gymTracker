// Stage 2 of the live-app review: voided payments in the Today feed, payment times, Resume for
// members on hold, "Report a problem", the member form checks, autofill and the hold fee field.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installPhotoDom } from "./helpers/fakeDom.js";
import { ageOn, dobCheck, feeWarning, memberWarnings, startDateWarning, warningsHtml } from "../../assets/js/memberChecks.js";
import { planImport, readImportRows, guessColumns } from "../../assets/js/modules/memberImport.js";
import { keepsAutofill, turnOffAutofill } from "../../assets/js/components/autofill.js";
import { supportWhatsApp, warnIfNoSupportWhatsApp } from "../services/accountService.js";
import { validateMemberPayload } from "../middleware/validateMember.js";

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const boot = installPhotoDom();
const { feedWhen, paymentMoment, recentPayments } = await import("../../assets/js/modules/dashboard.js");
const { memberMenuItems, renderMembers, rowPrimaryAction } = await import("../../assets/js/modules/members.js");
const { renderSupportSettings } = await import("../../assets/js/modules/account.js");
const { renderHoldSettings, renewalSettings, syncHoldFeeField } = await import("../../assets/js/modules/renewalSettingsUi.js");
const { renewWarnings } = await import("../../assets/js/modules/renewSheet.js");
const { state, memberFromApiRow } = await import("../../assets/js/state.js");
boot.restore();

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const TODAY = "2026-11-20";

// ---------- 1. Voided payments ----------

test("the Today feed leaves out voided payments (suman's second ₹1,000 is gone)", () => {
    const payments = [
        { id: "p2", member_id: "m1", amount: 1000, paid_on: "2026-11-17", created_at: "2026-11-17T06:10:00Z", status: "voided", member: { full_name: "suman" } },
        { id: "p1", member_id: "m1", amount: 1000, paid_on: "2026-11-17", created_at: "2026-11-17T06:00:00Z", status: "paid", member: { full_name: "suman" } }
    ];
    const feed = recentPayments(payments);
    assert.equal(feed.length, 1);
    assert.equal(feed[0].amount, 1000);
    assert.equal(recentPayments([{ ...payments[0] }]).length, 0);
});

test("money totals in the database and the browser leave out voided payments", () => {
    const sql = source("server/migrations/025_payment_rules_and_void.sql");
    for (const name of ["collected_this_month", "collected_all_time"]) assert.match(sql, new RegExp(`'${name}'[^\\n]*\\n?[^\\n]*status = 'paid'`), name);
    assert.match(sql, /kind = 'plan' AND status = 'paid'/, "balances count paid plan payments only");
});

// ---------- 2. Payment times ----------

test("a payment recorded the same day shows the time it was recorded", () => {
    const moment = paymentMoment({ paid_on: "2026-11-20", created_at: "2026-11-20T04:12:00Z" });
    assert.equal(moment.dateOnly, false);
    assert.equal(feedWhen(moment), "20 Nov 2026, 9:42 am");
});

test("a backdated or date-only payment shows the date only, never 12:00 pm", () => {
    const backdated = paymentMoment({ paid_on: "2026-11-15", created_at: "2026-11-20T04:12:00Z" });
    assert.equal(backdated.dateOnly, true);
    assert.equal(feedWhen(backdated), "15 Nov 2026");
    const noTime = paymentMoment({ paid_on: "2026-11-15" });
    assert.equal(feedWhen(noTime), "15 Nov 2026");
    assert.doesNotMatch(feedWhen(noTime), /12:00/);
    // India midnight: recorded at 00:30 IST on the 20th is the 19th in UTC.
    assert.equal(paymentMoment({ paid_on: "2026-11-20", created_at: "2026-11-19T19:00:00Z" }).dateOnly, false);
});

// ---------- 3. Members on hold ----------

const heldRow = (hold = { id: "11111111-1111-4111-8111-111111111111", starts_on: "2026-11-10" }) => memberFromApiRow({
    id: "00000000-0000-4000-8000-000000000009", full_name: "Asha Rao", member_code: "GP-9", phone: "9876543219",
    member_status: "on_hold", status_detail: { hold }
});

test("a member on hold gets Resume as the row button and in the menu, and no Renew", () => {
    const member = heldRow();
    assert.deepEqual(rowPrimaryAction(member), { action: "hold-resume", label: "Resume", hold: "11111111-1111-4111-8111-111111111111", style: "button-secondary" });
    assert.equal(memberMenuItems(member)[0].label, "Resume");
    state.members = [member];
    const html = renderMembers({});
    assert.match(html, /data-action="hold-resume" data-id="00000000-0000-4000-8000-000000000009" data-hold="11111111-1111-4111-8111-111111111111">Resume</);
    assert.doesNotMatch(html, />Renew</);
});

test("without the hold's id, Resume opens Renew, which still says 'Resume the plan first'", () => {
    assert.equal(rowPrimaryAction(heldRow(null)).action, "renew-member");
    assert.match(source("assets/js/modules/renewSheet.js"), /member\.memberStatus === "on_hold"[\s\S]{0,400}Resume the plan first/);
    assert.equal(rowPrimaryAction(memberFromApiRow({ id: "x", member_status: "expiring", status_detail: {} })).label, "Renew");
});

// ---------- 4. Report a problem ----------

test("Report a problem shows only when SUPPORT_WHATSAPP_NUMBER is set, with no developer text", () => {
    assert.match(renderSupportSettings({ support_whatsapp: "919876543210" }), /data-action="report-problem">Report a problem</);
    const hidden = renderSupportSettings({ support_whatsapp: "" });
    assert.doesNotMatch(hidden, /Report a problem|SUPPORT_WHATSAPP/);
    assert.match(hidden, /Terms of Service/);
});

test("the server warns on start when the support number is missing or invalid", () => {
    const logged = [];
    const log = { warn: (message) => logged.push(message) };
    assert.match(warnIfNoSupportWhatsApp({}, log), /not set/);
    assert.match(warnIfNoSupportWhatsApp({ SUPPORT_WHATSAPP_NUMBER: "12345" }, log), /not a valid/);
    assert.equal(warnIfNoSupportWhatsApp({ SUPPORT_WHATSAPP_NUMBER: "98765 43210" }, log), "");
    assert.equal(logged.length, 2);
    assert.equal(supportWhatsApp({ SUPPORT_WHATSAPP_NUMBER: "98765 43210" }), "919876543210");
    assert.match(source("server/server.js"), /warnIfNoSupportWhatsApp\(\)/);
});

// ---------- 5. Member form checks ----------

test("start date: more than 60 days ahead or a year back is asked about", () => {
    assert.equal(startDateWarning("2027-01-19", TODAY), "", "60 days ahead is fine");
    assert.equal(startDateWarning("2027-01-20", TODAY), "Start date is 20 Jan 2027. Is that right?");
    assert.equal(startDateWarning("2025-11-20", TODAY), "", "exactly a year back is fine");
    assert.equal(startDateWarning("2025-11-19", TODAY), "Start date is 19 Nov 2025. Is that right?");
});

test("date of birth: the future is refused; under 10 is asked about", () => {
    assert.deepEqual(dobCheck("2026-11-21", TODAY), { block: "Date of birth can't be in the future." });
    assert.deepEqual(dobCheck("2020-01-01", TODAY), { warning: "This member would be 6 years old. Is that right?" });
    assert.deepEqual(dobCheck("2016-11-20", TODAY), {}, "10 today");
    assert.equal(ageOn("2016-11-21", TODAY), 9);
    assert.deepEqual(dobCheck("", TODAY), {});
});

test("fee: below half the plan price or above it is asked about", () => {
    assert.equal(feeWarning(1500, 1500), "");
    assert.equal(feeWarning(750, 1500), "", "exactly half is fine");
    assert.equal(feeWarning(700, 1500), "Fee ₹700 is different from the plan price ₹1,500. Is that right?");
    assert.equal(feeWarning(2000, 1500), "Fee ₹2,000 is different from the plan price ₹1,500. Is that right?");
    assert.equal(feeWarning("", 1500), "");
});

test("Add, Edit, Renew and Import all use the same checks", () => {
    const add = memberWarnings({ startDate: "2027-03-01", dob: "2020-01-01", fee: 100, planPrice: 1500, today: TODAY });
    assert.equal(add.block, "");
    assert.equal(add.warnings.length, 3);
    assert.equal(memberWarnings({ dob: "2030-01-01", today: TODAY }).block, "Date of birth can't be in the future.");
    const main = source("assets/js/main.js");
    assert.match(main, /memberWarnings\(\{\s*dob:[\s\S]{0,200}isNewMember \? \{ startDate, fee: values\.get\("totalFees"\), planPrice: plan\.price \} : \{\}/, "add checks all three; edit checks the date of birth");
    assert.match(main, /if \(checks\.block\) throw new Error\(checks\.block\)/);
    const html = warningsHtml(["Start date is 1 Mar 2027. Is that right?"]);
    assert.match(html, /data-check="back">Go back</);
    assert.match(html, /data-check="confirm">Yes, save</);
});

test("Renew asks about a start date the owner picked and a price far from the plan's", () => {
    const plan = { id: "p", price: 1500 };
    assert.deepEqual(renewWarnings({ plan, ownerDate: false, startDate: "2027-06-01", request: { total_fees: 1500 } }), [], "the automatic start is never asked about");
    assert.equal(renewWarnings({ plan, ownerDate: true, startDate: "2027-06-01", request: { total_fees: 1500 } }).length, 1);
    assert.deepEqual(renewWarnings({ plan, ownerDate: false, request: { total_fees: 500 } }), ["Fee ₹500 is different from the plan price ₹1,500. Is that right?"]);
    assert.deepEqual(renewWarnings({ plan, ownerDate: false, request: { total_fees: 1200 }, welcomeBack: { amount: 300 } }, true), [], "welcome back price is expected");
});

test("Import shows start-date questions as warnings in the preview and still saves the row", () => {
    const text = (...values) => values.map((value) => ({ text: value }));
    const header = text("Name", "Phone", "Plan", "Start date");
    const rows = readImportRows([header, text("Riya Shah", "9876543210", "Monthly", "01/01/2024"), text("Dev Rao", "9876543211", "Monthly", "15/11/2026")], 0, guessColumns(header));
    const plan = planImport(rows, { activePlans: [{ id: "p1", name: "Monthly", duration_days: 30, price: 1500 }], today: TODAY });
    assert.equal(plan.ready.length, 2, "warnings never leave a row out");
    assert.deepEqual(plan.ready[0].warnings, ["Start date is 01 Jan 2024. Is that right?"]);
    assert.deepEqual(plan.ready[1].warnings, []);
    assert.match(source("assets/js/modules/memberImportUi.js"), /import-warning/);
});

test("the server refuses a date of birth in the future", () => {
    const run = (body) => {
        let sent = null;
        const response = { status: () => ({ json: (payload) => { sent = payload; } }) };
        let passed = false;
        validateMemberPayload("update")({ body }, response, () => { passed = true; });
        return { passed, sent };
    };
    const future = run({ date_of_birth: "2999-01-01" });
    assert.equal(future.passed, false);
    assert.equal(future.sent.message, "Date of birth can't be in the future.");
    assert.equal(run({ date_of_birth: "1990-05-01" }).passed, true);
});

// ---------- 6. Autofill ----------

test("member, enquiry, payment, renew and hold forms turn autofill off; sign-in fields keep it", () => {
    const main = source("assets/js/main.js");
    assert.match(main, /<form id="member-form" autocomplete="off"/);
    assert.doesNotMatch(main, /quick-member-form/, "Quick add is merged into Add member");
    assert.match(main, /<form id="payment-form" autocomplete="off"/);
    assert.doesNotMatch(main, /autocomplete="(name|email|tel)"/, "no field asks for the owner's own details");
    assert.match(main, /watchDialogAutofill\(\);/);
    assert.match(source("assets/js/modules/enquiriesPage.js"), /<form id="enquiry-form" autocomplete="off"/);
    assert.match(source("assets/js/modules/renewSheet.js"), /<form id="renew-form" autocomplete="off"/);
    assert.match(source("assets/js/modules/holds.js"), /<form id="hold-form" autocomplete="off"/);
    for (const path of ["assets/js/entrance.js", "assets/js/modules/account.js"]) assert.doesNotMatch(source(path), /autocomplete="off"[^>]*type="password"/);
    assert.equal(keepsAutofill({ type: "password", getAttribute: () => "current-password" }), true);
    assert.equal(keepsAutofill({ type: "text", getAttribute: () => "username" }), true);
    assert.equal(keepsAutofill({ type: "email", getAttribute: () => null }), false);
});

test("fields a dialog adds later get autofill turned off too", () => {
    const attrs = (type, autocomplete) => {
        const values = autocomplete ? { autocomplete } : {};
        return { type, getAttribute: (name) => values[name] ?? null, setAttribute: (name, value) => { values[name] = value; }, values };
    };
    const email = attrs("email");
    const password = attrs("password", "current-password");
    const root = { querySelectorAll: (selector) => (selector === "form" ? [] : [email, password]), matches: () => false };
    turnOffAutofill(root);
    assert.equal(email.values.autocomplete, "off");
    assert.equal(password.values.autocomplete, "current-password");
});

// ---------- 7. Hold fee amount ----------

test("Plan holds: Hold fee amount shows only when a hold fee is chosen", () => {
    renewalSettings.status = "ready";
    renewalSettings.data = { can_edit: true, min_hold_days: 15, hold_fee_enabled: false, hold_fee_amount: 0 };
    assert.match(renderHoldSettings(), /id="setting-hold-fee-amount-field" hidden/);
    renewalSettings.data.hold_fee_enabled = true;
    assert.doesNotMatch(renderHoldSettings(), /id="setting-hold-fee-amount-field" hidden/);
    const field = { hidden: true };
    const select = { id: "setting-hold-fee", value: "true", form: { querySelector: (selector) => (selector === "#setting-hold-fee-amount-field" ? field : { focus() {} }) } };
    assert.equal(syncHoldFeeField(select), true);
    assert.equal(field.hidden, false);
    select.value = "false";
    syncHoldFeeField(select);
    assert.equal(field.hidden, true);
    assert.equal(syncHoldFeeField({ id: "other" }), false);
});

// ---------- 8. Privacy policy ----------

test("the privacy policy says there are no automatic backups", () => {
    const privacy = source("privacy.html");
    assert.match(privacy, /does not keep automatic backups/);
    assert.doesNotMatch(privacy, /backups kept by our provider are deleted within/);
});
