// Stage 5 of the live-app review: Members (a button only where the row needs one, the whole row
// opens the profile, header "⋯" menu, Clear filters), Check-in (one manual button, approvals as one
// line when empty, rules in a help panel) and Plans ("⋯" menu, delete only for plans never used).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installPhotoDom } from "./helpers/fakeDom.js";
import { withUsage } from "../services/plansService.js";

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const boot = installPhotoDom();
const { RENEW_STATUSES, filterMembers, memberMenuItems, renderMembers, rowPrimaryAction } = await import("../../assets/js/modules/members.js");
const { CHECKIN_RULES, pendingDevices, renderApprovals, renderVisitsSection } = await import("../../assets/js/modules/attendance.js");
const { planDeleteBlocked, planMenu, planRulesLine, renderPlansPage } = await import("../../assets/js/modules/plans.js");
const { state, memberFromApiRow } = await import("../../assets/js/state.js");
boot.restore();

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const member = (status, extra = {}) => memberFromApiRow({ id: `00000000-0000-4000-8000-${String(status.length).padStart(12, "0")}`, full_name: "Riya Shah", member_code: "GP-7", phone: "9876543210", member_status: status, status_detail: {}, ...extra });

// ---------- Members ----------

test("row button by status: Renew (marigold) when a renewal is due, Resume on hold, none when active", () => {
    for (const status of ["expiring", "in_grace", "lapsed", "old"]) {
        assert.deepEqual(rowPrimaryAction(member(status)), { action: "renew-member", label: "Renew", hold: "", style: "button-primary" }, status);
        assert.ok(RENEW_STATUSES.has(status));
    }
    assert.equal(rowPrimaryAction(member("on_hold", { status_detail: { hold: { id: "h1" } } })).label, "Resume");
    assert.equal(rowPrimaryAction(member("active")), null);
    assert.equal(rowPrimaryAction(member("upcoming")), null);
    assert.equal(memberMenuItems(member("active"))[0].label, "Renew", "Renew is inside the menu");
});

test("an active member's row has only the ⋯ menu; the whole row opens the profile", () => {
    state.members = [member("active")];
    const html = renderMembers({});
    const row = html.slice(html.indexOf("<tr class=\"member-row\""));
    assert.match(row, /data-row-profile="[^"]+"/);
    assert.doesNotMatch(row.slice(row.indexOf('data-label="Actions"')), /class="button /, "no main button");
    assert.match(row, /class="row-menu-button"/);
    assert.match(source("assets/js/main.js"), /closest\("tr\[data-row-profile\]"\)[\s\S]{0,120}!event\.target\.closest\("button, a, input, select, label, \.row-menu-wrap"\)/);
});

test("the ⋯ menu has a divider above Delete member", () => {
    state.members = [member("active")];
    assert.match(renderMembers({}), /<div class="row-menu-divider" role="separator"><\/div><button class="row-menu-item is-danger"[^>]*>Delete member</);
});

test("Members header: Add member, and Import members / Export CSV behind ⋯", () => {
    state.members = [];
    const html = renderMembers({});
    const heading = html.slice(0, html.indexOf("</div></div>") + 12);
    assert.match(heading, /class="button button-primary" type="button" data-action="add-member">＋ Add member</);
    assert.match(heading, /aria-label="More member actions"/);
    assert.match(heading, /role="menuitem" data-action="export-members">Export CSV</);
    assert.doesNotMatch(heading, /class="button button-secondary"/, "no loose secondary buttons");
});

test("search says 'Search name or phone', still finds member codes, and an empty result offers Clear filters", () => {
    state.members = [member("active")];
    const html = renderMembers({ search: "zzz" });
    assert.match(html, /placeholder="Search name or phone"/);
    assert.match(html, /data-action="clear-member-filters">Clear filters</);
    assert.equal(filterMembers({ search: "gp-7" }).length, 1, "member code search still works");
    assert.match(source("assets/js/main.js"), /case "clear-member-filters":[\s\S]{0,120}search: "", filter: "all"/);
});

// ---------- Check-in ----------

test("Check-in has one 'Check in manually' button, at the top", () => {
    const attendance = source("assets/js/modules/attendance.js");
    assert.equal((attendance.match(/data-action="checkin-by-name"/g) || []).length, 1);
    assert.match(attendance, />Check in manually<\/button>`;/);
    assert.doesNotMatch(attendance, /Can't scan\?/);
    const poster = attendance.slice(attendance.indexOf('data-method="entrance_poster"'));
    assert.ok(poster.indexOf("manualButton") < poster.indexOf("deskResultHtml()"), "manual first on the poster page");
    const qr = attendance.slice(attendance.indexOf('data-method="member_qr"'), attendance.indexOf('data-method="entrance_poster"'));
    assert.ok(qr.indexOf("scanner-root") < qr.indexOf("manualButton") && qr.indexOf("manualButton") < qr.indexOf("visits-section"), "scanner, then manual, then visits");
});

test("Phones waiting for approval: one line when empty, the full card with a badge when someone waits", () => {
    Object.assign(pendingDevices, { status: "ready", rows: [] });
    assert.equal(renderApprovals(), `<section class="card checkin-card approvals-line" id="device-approvals"><p role="status">No phones waiting</p></section>`);
    pendingDevices.rows = [{ id: "d1", code: "4821", created_at: "2026-11-20T04:00:00Z", member: { full_name: "Riya Shah", member_code: "GP-7" } }];
    const html = renderApprovals();
    assert.match(html, /Phones waiting for approval <span class="count-pill">1<\/span>/);
    assert.match(html, /data-action="device-approve"/);
});

test("the rules paragraph is a 'How check-in works' help panel", () => {
    state.attendance = [];
    const html = renderVisitsSection();
    assert.match(html, /data-action="checkin-help">How check-in works</);
    assert.doesNotMatch(html, /Members in grace are checked in with a warning; lapsed/);
    assert.ok(CHECKIN_RULES.length >= 4 && CHECKIN_RULES.every((rule) => rule.length < 110), "short lines");
});

// ---------- Plans ----------

const plan = { id: "p1", name: "Monthly", price: 1500, duration_days: 30, is_active: true, grace_days: 3, max_hold_days: null, max_holds: null, description: "" };

test("each plan has a ⋯ menu: Edit, Deactivate, divider, Delete; no text links", () => {
    const html = planMenu(plan);
    const items = [...html.matchAll(/data-action="([a-z-]+)" data-id="p1">([^<]+)</g)].map((m) => m[2]);
    assert.deepEqual(items, ["Edit", "Deactivate", "Delete"]);
    assert.ok(html.indexOf("row-menu-divider") > html.indexOf("Deactivate") && html.indexOf("row-menu-divider") < html.indexOf(">Delete<"));
    assert.doesNotMatch(source("assets/js/modules/plans.js"), /class="text-button" data-action="(edit|toggle|delete)-plan"/);
});

test("delete is only for plans no member has used; used ones say 'Deactivate it instead'", () => {
    assert.equal(planDeleteBlocked({ ...plan, used: true }), true);
    assert.equal(planDeleteBlocked({ ...plan, used: false }), false);
    assert.equal(planDeleteBlocked({ ...plan, used: null }), false, "unknown: the database decides, and a refusal shows the same message");
    const plans = source("assets/js/modules/plans.js");
    assert.match(plans, /<strong>Deactivate it instead<\/strong>/);
    assert.match(plans, /error\?\.status === 409[\s\S]{0,160}showDeleteBlocked\(plan\)/);
});

test("the server marks plans used when any membership (even cancelled) came from them, within the gym", async () => {
    const calls = [];
    const client = { from: (table) => {
        const filters = {};
        const query = { select: () => query, eq: (column, value) => { filters[column] = value; return query; }, limit: () => {
            calls.push({ table, ...filters });
            return Promise.resolve({ data: filters.plan_id === "p1" ? [{ id: "m1" }] : [], error: null });
        } };
        return query;
    } };
    const result = await withUsage([{ id: "p1" }, { id: "p2" }], "gym-a", client);
    assert.deepEqual(result.map((row) => row.used), [true, false]);
    assert.ok(calls.every((call) => call.table === "member_memberships" && call.gym_id === "gym-a"), "always filtered by gym");
    const failing = { from: () => { throw new Error("down"); } };
    assert.deepEqual((await withUsage([{ id: "p1" }], "gym-a", failing)).map((row) => row.used), [null]);
});

test("Plans page: no Refresh button, the count once, no 'on this page', no 'No description provided.'", () => {
    const html = renderPlansPage();
    assert.doesNotMatch(html, /refresh-plans">↻ Refresh|on this page|No description provided/);
    assert.doesNotMatch(html, /summary-chip/);
    assert.equal(planRulesLine(plan), "Grace 3 days · Holds: no holds");
    assert.equal(planRulesLine({ ...plan, duration_days: 90, grace_days: null }), "Grace: gym default · Holds: up to 30 days, 1 hold");
});
