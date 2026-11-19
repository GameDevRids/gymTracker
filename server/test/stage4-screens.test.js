// Stage 4 screens: Today's Needs attention, the Members row actions, Follow-ups with WhatsApp, the
// Settings sections (one marigold button each, buttons not full width), and the Reports page.
import test from "node:test";
import assert from "node:assert/strict";
import { installPhotoDom } from "./helpers/fakeDom.js";
import { buildFollowupMessage } from "../../assets/js/followupMessage.js";
import { planLegendHtml, PLAN_COLORS } from "../../assets/js/components/charts.js";
import { SETTINGS_SECTIONS, resolveSection, resolveView } from "../../assets/js/navigation.js";
import { readFileSync } from "node:fs";

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const boot = installPhotoDom();
const { renderNeedsAttention, attentionItems } = await import("../../assets/js/modules/dashboard.js");
const { memberMenuItems, renderMembers } = await import("../../assets/js/modules/members.js");
const { followupWhatsApp, renderFollowups, renderOperationsPage, retentionRows } = await import("../../assets/js/modules/operations.js");
const { renewalSettingsBody } = await import("../../assets/js/modules/renewalSettingsUi.js");
const { settingsPage, showSettingsList, showSettingsSection } = await import("../../assets/js/modules/settingsPage.js");
const { state, memberFromApiRow } = await import("../../assets/js/state.js");
const { gymSummary } = await import("../../assets/js/modules/summary.js");
const { welcomeTemplates } = await import("../../assets/js/modules/welcome.js");
const { reminderTemplates } = await import("../../assets/js/modules/expiryReminder.js");
boot.restore();

// The two message editors show "Loading…" until their templates arrive; here they have.
welcomeTemplates.status = "ready";
reminderTemplates.status = "ready";
const css = readFileSync(new URL("../../assets/css/theme.css", import.meta.url), "utf8");

// ---------- Today: Needs attention ----------

test("Needs attention shows only what has a count, in order, each opening its list", () => {
    const summary = { status_counts: { expiring: 3, in_grace: 0 }, members_with_balance: 2, outstanding_total: 4500 };
    const html = renderNeedsAttention(summary, 5, 0, 1);
    const buttons = [...html.matchAll(/<button class="attention-item" type="button" data-view="([a-z]+)"(?: data-tab="([a-z_]+)")?><strong>(\d+)<\/strong><span>([^<]+)/g)].map((m) => m.slice(1));
    assert.deepEqual(buttons, [["payments", undefined, "2", "Dues"], ["renewals", "followups", "5", "Follow-ups"], ["members", "on_hold", "1", "Holds ending this week"], ["renewals", "expiring", "3", "Expiring this week"]]);
    assert.match(html, /₹4,500 outstanding/);
    assert.doesNotMatch(html, /All caught up/, "zero items are simply left out");
});

test("with nothing to do, Needs attention is one line: All caught up for today", () => {
    const html = renderNeedsAttention({ status_counts: { expiring: 0, in_grace: 0 }, members_with_balance: 0, outstanding_total: 0 }, 0, 0, 0);
    assert.equal(html, `<p class="attention-clear is-all" role="status">✓ All caught up for today</p>`);
});

test("Needs attention reads the shared status counts, and the older summary figure when they are missing", () => {
    const expiring = (summary) => attentionItems(summary, 0).find((item) => item.key === "expiring").value;
    assert.equal(expiring({ status_counts: { expiring: 4, in_grace: 1 } }), 4);
    assert.equal(expiring({ status_counts: null, expiring_in_7_days: 6 }), 6);
    assert.deepEqual(attentionItems({}, 0).map((item) => item.key), ["dues", "followups", "enquiries", "in_grace", "holds_ending", "expiring"]);
    assert.equal(attentionItems({}, 0).every((item) => item.value === 0), true);
});

// ---------- Members: one action and a menu ----------

test("a member's row: Renew, and a menu with Edit, Record payment, Assign plan (no plan only), Put on hold (running plan only), Delete", () => {
    // Review stage 5: Renew is in the menu when it is not the row's button; a divider before Delete.
    const labels = (status) => memberMenuItems({ memberStatus: status }).map((item) => item.label || "—");
    assert.deepEqual(labels("none"), ["Edit", "Record payment", "Assign plan", "—", "Delete member"]);
    assert.deepEqual(labels("active"), ["Renew", "Edit", "Record payment", "Put on hold", "—", "Delete member"]);
    assert.deepEqual(labels("expiring"), ["Edit", "Record payment", "Put on hold", "—", "Delete member"]);
    assert.deepEqual(labels("on_hold"), ["Resume", "Edit", "Record payment", "—", "Delete member"]);
    assert.deepEqual(labels("upcoming"), ["Renew", "Edit", "Record payment", "—", "Delete member"]);
    for (const status of ["in_grace", "lapsed", "old"]) {
        assert.deepEqual(labels(status), ["Edit", "Record payment", "—", "Delete member"], status);
    }
    assert.equal(memberMenuItems({ memberStatus: "active" }).at(-1).danger, true);
});

test("the Members list draws Renew and the menu in each row, and no row of text links", () => {
    state.members = [memberFromApiRow({ id: "00000000-0000-4000-8000-000000000001", full_name: "Riya Shah", member_code: "GP-101", phone: "9876543210", member_status: "expiring", status_detail: { days_left: 3 } })];
    const html = renderMembers({});
    assert.equal((html.match(/data-action="renew-member"/g) || []).length, 1);
    assert.match(html, /class="row-menu-button"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-label="More actions for Riya Shah"/);
    assert.match(html, /role="menu"[^>]*hidden/);
    assert.equal(/class="text-button"[^>]*data-action="(assign-member-plan|record-payment|edit-member)"/.test(html), false, "the four text links are gone");
    assert.match(html, /<strong>Riya Shah<\/strong><small>GP-101<\/small>/, "name and code share one column");
    assert.ok(css.includes('.members-table tbody td[data-label="Phone"] { display: none; }'), "phones show cards without the phone column");
});

test("a member can be found by the code they had before it was shortened", () => {
    const member = memberFromApiRow({ id: "00000000-0000-4000-8000-000000000002", full_name: "Dev Rao", member_code: "GP-102", previous_member_code: "GP-D99D8ECC34DB" });
    assert.equal(member.previousCode, "GP-D99D8ECC34DB");
    state.members = [member];
    assert.match(renderMembers({ search: "d99d8ecc" }), /Dev Rao/);
    assert.equal(renderMembers({ search: "zzz" }).includes("Dev Rao"), false);
});

// ---------- Follow-ups ----------

const memberOf = (fields) => memberFromApiRow({ id: `00000000-0000-4000-8000-${String(Math.random()).slice(2, 14).padEnd(12, "0")}`, phone: "9876543210", created_at: "2026-01-01T05:00:00Z", member_status: "active", status_detail: {}, ...fields });

test("Follow-ups leave out old members, members with no plan and members on hold", () => {
    state.attendance = [];
    state.members = [
        memberOf({ full_name: "Active Ann", member_status: "active" }),
        memberOf({ full_name: "Old Oscar", member_status: "old" }),
        memberOf({ full_name: "No Plan Nina", member_status: "none" }),
        memberOf({ full_name: "Away Amit", member_status: "on_hold" }),
        memberOf({ full_name: "Lapsed Lata", member_status: "lapsed" })
    ];
    assert.deepEqual(retentionRows().map((row) => row.member.name).sort(), ["Active Ann", "Lapsed Lata"]);
});

test("a follow-up's WhatsApp button needs consent and a valid number; otherwise it says why", () => {
    const base = { name: "Riya Shah", savedName: "Riya Shah", phone: "9876543210", whatsappOptIn: true };
    state.gym.name = "Power Gym";
    const ok = followupWhatsApp(base, 20);
    assert.match(ok.link, /^https:\/\/wa\.me\/919876543210\?text=/);
    assert.match(decodeURIComponent(ok.link), /Hi Riya, we haven't seen you at Power Gym for 20 days/);
    assert.deepEqual(followupWhatsApp({ ...base, whatsappOptIn: false }, 20), { blocked: "No WhatsApp consent" });
    assert.deepEqual(followupWhatsApp({ ...base, phone: "12345" }, 20), { blocked: "No valid mobile number" });
    // A member saved without a usable name is greeted as "there", never by their email.
    assert.match(decodeURIComponent(followupWhatsApp({ ...base, name: "No name – tap to add", savedName: "x@y.com" }, 3).link), /Hi there, how is your training going/);
});

test("the follow-up message: 'we haven't seen you' from 14 days, otherwise a general check-in, in each language", () => {
    const fields = { name: "Riya Shah", gymName: "Power Gym", gymPhone: "98220 01122" };
    assert.match(buildFollowupMessage({ ...fields, days: 14 }), /haven't seen you at Power Gym for 14 days/);
    assert.match(buildFollowupMessage({ ...fields, days: 13 }), /how is your training going/);
    assert.match(buildFollowupMessage({ ...fields, days: null }), /how is your training going/);
    assert.match(buildFollowupMessage({ ...fields, days: 20 }), /98220 01122/);
    assert.doesNotMatch(buildFollowupMessage({ name: "Riya", gymName: "G", days: 20 }), /Call/);
    assert.match(buildFollowupMessage({ ...fields, days: 20, language: "hi" }), /नमस्ते Riya.*20/);
    assert.match(buildFollowupMessage({ ...fields, days: 20, language: "mr" }), /नमस्कार Riya.*20/);
});

test("Follow-ups are cards: a status choice and a WhatsApp button per member, never a wide table", () => {
    state.attendance = [];
    state.members = [memberOf({ full_name: "Active Ann", whatsapp_opt_in: true }), memberOf({ full_name: "Quiet Quinn", whatsapp_opt_in: false, follow_up_status: "contacted" })];
    const html = renderFollowups();
    assert.equal((html.match(/class="card followup-card"/g) || []).length, 2);
    assert.equal(html.includes("<table"), false);
    assert.equal((html.match(/data-followup-message=/g) || []).length, 1, "only the member who agreed gets the button");
    assert.match(html, /No WhatsApp consent/);
    assert.match(html, /<option value="contacted" selected>/);
    assert.match(html, /1<\/strong> contacted/);
    state.members = [];
    assert.match(renderFollowups(), /No one needs a follow-up right now/);
});

// ---------- Settings ----------

test("Settings has eight sections; the list always shows them, and only the chosen one is drawn", () => {
    assert.deepEqual(SETTINGS_SECTIONS, ["details", "payments", "attendance", "renewals", "holds", "messages", "account", "help"]);
    showSettingsSection("payments", false);
    const html = renderOperationsPage("settings");
    assert.deepEqual([...html.matchAll(/data-settings-section="([a-z]+)"/g)].map((m) => m[1]), SETTINGS_SECTIONS);
    assert.match(html, /class="settings-nav-item is-active" type="button" data-settings-section="payments" aria-current="page"/);
    assert.match(html, /id="setting-upiId"/, "the chosen section is drawn");
    assert.equal(html.includes('id="setting-language"'), false, "the others are not");
    assert.equal(html.includes("settings-shell is-open"), false, "a phone shows the list first");
    showSettingsSection("details", true);
    assert.match(renderOperationsPage("settings"), /class="settings-shell is-open"/);
    assert.match(renderOperationsPage("settings"), /data-settings-back/);
    showSettingsList();
    assert.equal(settingsPage.open, false);
});

test("each section has at most one marigold button (its save); the rest are secondary", () => {
    for (const section of SETTINGS_SECTIONS) {
        showSettingsSection(section, true);
        const html = renderOperationsPage("settings");
        const content = html.slice(html.indexOf('class="settings-content"'));
        const primaries = (content.match(/class="button button-primary"/g) || []).length;
        assert.ok(primaries <= 1, `${section}: ${primaries} primary buttons`);
    }
    showSettingsSection("account", true);
    const account = renderOperationsPage("settings");
    assert.match(account, /class="button button-secondary" type="submit">Change password/);
    showSettingsSection("messages", true);
    assert.match(renderOperationsPage("settings"), /class="button button-secondary" type="button" data-action="welcome-reset-template">Use default/);
});

test("the Messages section holds both editable templates, each in every language, and says what else is built in", () => {
    showSettingsSection("messages", true);
    const html = renderOperationsPage("settings");
    assert.match(html, /id="welcome-language"/);
    assert.match(html, /id="reminder-language"/);
    assert.match(html, /Other messages/);
    assert.match(html, /every one is added to the member's WhatsApp history/);
});

test("Settings links: notifications opens Messages; Save buttons are as wide as their label", () => {
    assert.equal(resolveView("notifications").section, "messages");
    assert.equal(resolveSection("messages"), "messages");
    assert.equal(resolveSection("nonsense"), "details");
    assert.ok(css.includes(".settings-content .button { width: auto; }"));
    // A form field is a column, so a button in it must align itself to the start or it stretches.
    assert.match(css, /.settings-content .field > .button[^{]*{ align-self: flex-start; }/);
});

test("the plan hold and renewal settings are separate forms that save only their own fields", () => {
    const form = (entries) => ({ id: "x", [Symbol.iterator]: undefined, entries });
    const withForm = (entries) => {
        const original = globalThis.FormData;
        globalThis.FormData = class { constructor(source) { this.map = new Map(source.entries); } has(name) { return this.map.has(name); } get(name) { return this.map.get(name) ?? null; } };
        try { return renewalSettingsBody(form(entries)); } finally { globalThis.FormData = original; }
    };
    assert.deepEqual(withForm([["expiry_grace_days", "3"], ["lapsed_list_days", "60"], ["welcome_back_discount_type", "percent"], ["welcome_back_discount_value", "10"]]).body,
        { expiry_grace_days: 3, lapsed_list_days: 60, welcome_back_discount_type: "percent", welcome_back_discount_value: 10 });
    assert.deepEqual(withForm([["min_hold_days", "15"], ["hold_fee_enabled", "true"], ["hold_fee_amount", "200"]]).body,
        { min_hold_days: 15, hold_fee_enabled: true, hold_fee_amount: 200 });
    assert.match(withForm([["min_hold_days", "400"]]).problem, /0 to 365/);
    assert.match(withForm([["hold_fee_enabled", "true"], ["hold_fee_amount", "0"]]).problem, /above 0/);
    assert.match(withForm([["expiry_grace_days", "61"]]).problem, /0 to 60/);
    assert.match(withForm([["welcome_back_discount_type", "percent"], ["welcome_back_discount_value", "150"]]).problem, /at most 100/);
});

// ---------- Reports ----------

test("Reports: eight stat cards fill the grid (no empty cell), and the numbers come first", () => {
    gymSummary.status = "ready";
    gymSummary.data = {
        total_members: 10, active_members: 6, status_counts: { active: 5, expiring: 2 }, new_members_this_month: 1,
        renewed_last_30_days: 1, due_last_30_days: 2, collected_this_month: 12000, collected_all_time: 50000, outstanding_total: 3000,
        months: [], active_by_plan: [{ plan_name: "Monthly Membership Plus", members: 3 }]
    };
    state.attendance = [];
    showSettingsList();
    const html = renderOperationsPage("reports");
    assert.equal((html.match(/class="card kpi-card"/g) || []).length, 8);
    assert.ok(html.indexOf("kpi-grid") < html.indexOf('id="downloads"'), "charts and numbers before the downloads");
    assert.match(html, /Collected this month/);
    assert.match(html, /id="plan-legend"/);
});

test("the plan legend lists every plan's full name, with its colour and count, and escapes text", () => {
    const html = planLegendHtml([{ plan_name: "Monthly Membership Plus", members: 12 }, { plan_name: "<b>Quarterly</b>", members: 3 }]);
    assert.match(html, /Monthly Membership Plus<\/span><strong>12<\/strong>/);
    assert.match(html, /&lt;b&gt;Quarterly&lt;\/b&gt;/);
    assert.match(html, new RegExp(`background:${PLAN_COLORS[1]}`));
    assert.equal(planLegendHtml([]), "");
});
