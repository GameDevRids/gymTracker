// The new navigation (assets/js/navigation.js, index.html, modules/renewalsPage.js): the pages, where
// the old ones went, the Renewals badge, and the markup of the sidebar and phone tab bar.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_VIEW, REDIRECTS, RENEWAL_TABS, VIEW_IDS, renewalsBadgeCount, resolveTab, resolveView } from "../../assets/js/navigation.js";

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { renderRenewalsPage } = await import("../../assets/js/modules/renewalsPage.js");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("../../assets/js/main.js", import.meta.url), "utf8");
const viewsIn = (markup) => [...markup.matchAll(/data-view="([a-z]+)"/g)].map((match) => match[1]);
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

// ---------- The pages ----------

test("the sidebar is Today, Members, Check-in, Payments, Renewals, Plans, Reports, Settings, in that order", () => {
    assert.deepEqual(viewsIn(between('<nav class="navigation"', "</aside>")), ["overview", "members", "scan", "payments", "renewals", "plans", "reports", "settings"]);
    assert.deepEqual(VIEW_IDS, ["overview", "members", "scan", "payments", "renewals", "plans", "reports", "settings"]);
    assert.equal(DEFAULT_VIEW, "overview");
    const labels = [...between('<nav class="navigation"', "</aside>").matchAll(/class="nav-label">([^<]+)</g)].map((match) => match[1]);
    assert.deepEqual(labels, ["Today", "Members", "Check-in", "Payments", "Renewals", "Plans", "Reports", "Settings"]);
});

test("the removed pages and groups are gone from the markup", () => {
    // The page chrome only (the icon sprite is separate): sidebar, top bar and phone tab bar.
    const chrome = between('<aside class="sidebar"', "</aside>") + between('<header class="topbar">', "</header>") + between('<nav class="mobile-bottom-nav"', "</nav>");
    for (const gone of ["integrations", "notifications", "retention", "analytics", "attendance", "expiring", "nav-more", "Workspace", "breadcrumbs", "logout-button", "notification-button", "top-avatar", "member-count"]) {
        assert.equal(chrome.includes(gone), false, gone);
    }
});

test("the phone tab bar is Today, Members, Check-in, Renewals, More", () => {
    const bar = between('<nav class="mobile-bottom-nav"', "</nav>");
    assert.deepEqual(viewsIn(bar), ["overview", "members", "scan", "renewals"]);
    assert.match(bar, /data-action="mobile-more"/);
    assert.deepEqual([...bar.matchAll(/class="nav-label">([^<]+)</g)].map((match) => match[1]), ["Today", "Members", "Check-in", "Renewals", "More"]);
});

test("Log out is only in the account menu at the bottom of the sidebar (and Settings), never in the top bar", () => {
    const top = between('<header class="topbar">', "</header>");
    assert.equal(/sign-out|Log out/.test(top), false);
    const menu = between('<div class="account-wrap">', "</aside>");
    assert.match(menu, /id="account-menu"[^>]*hidden/);
    assert.match(menu, /data-action="sign-out"[^>]*>Log out</);
    assert.match(menu, /aria-haspopup="menu"/);
    assert.match(menu, /aria-expanded="false"/);
});

test("the top bar has the page title and the date, no breadcrumb", () => {
    const top = between('<header class="topbar">', "</header>");
    assert.match(top, /id="current-page"/);
    assert.match(top, /id="today-label"/);
    assert.equal(top.includes("breadcrumbs"), false);
    assert.equal(top.includes("Workspace"), false);
});

test("badges mean 'needs action': Renewals has one, Members does not", () => {
    const sidebar = between('<nav class="navigation"', "</aside>");
    const members = sidebar.slice(sidebar.indexOf('data-view="members"'), sidebar.indexOf("</button>", sidebar.indexOf('data-view="members"')));
    assert.equal(members.includes("nav-count"), false);
    assert.match(sidebar, /id="renewals-count"/);
    assert.match(between('<nav class="mobile-bottom-nav"', "</nav>"), /id="renewals-count-mobile"/);
});

// ---------- Old links go to their new home ----------

test("old page ids open their new pages: saved pages, links and bookmarks", () => {
    assert.deepEqual(resolveView("expiring"), { view: "renewals", tab: "expiring" });
    assert.deepEqual(resolveView("retention"), { view: "renewals", tab: "followups" });
    assert.deepEqual(resolveView("attendance"), { view: "scan" });
    assert.deepEqual(resolveView("analytics"), { view: "reports" });
    assert.deepEqual(resolveView("notifications"), { view: "settings", section: "messages" }, "its message templates are in Settings");
    assert.deepEqual(resolveView("integrations"), { view: "settings" });
    assert.deepEqual(Object.keys(REDIRECTS).sort(), ["analytics", "attendance", "expiring", "integrations", "notifications", "retention"]);
});

test("current pages, #links and the profile resolve to themselves; unknown ids and sign-in links do not", () => {
    for (const id of VIEW_IDS) assert.deepEqual(resolveView(id), { view: id }, id);
    assert.deepEqual(resolveView("#renewals"), { view: "renewals" });
    assert.deepEqual(resolveView("#Attendance"), { view: "scan" });
    assert.deepEqual(resolveView("profile"), { view: "profile" });
    for (const id of ["", null, undefined, "nope", "#access_token=abc&type=recovery", "__proto__", "constructor"]) assert.equal(resolveView(id), null, String(id));
});

test("every old link in the app resolves, so none is left dead", () => {
    const linked = new Set(viewsIn(html));
    for (const file of ["dashboard.js", "attendance.js", "members.js", "setupChecklist.js", "expiring.js", "lapsed.js", "renewalsPage.js", "operations.js"]) {
        for (const view of viewsIn(readFileSync(new URL(`../../assets/js/modules/${file}`, import.meta.url), "utf8"))) linked.add(view);
    }
    for (const view of viewsIn(main)) linked.add(view);
    for (const view of linked) assert.ok(resolveView(view), `data-view="${view}" has nowhere to go`);
});

test("tabs: a saved or linked tab is used, anything else is Expiring soon", () => {
    assert.deepEqual(RENEWAL_TABS, ["expiring", "lapsed", "old", "followups"]);
    assert.equal(resolveTab("followups"), "followups");
    assert.equal(resolveTab("nope"), "expiring");
    assert.equal(resolveTab(undefined), "expiring");
});

// ---------- The Renewals badge ----------

test("the Renewals badge counts members still to remind plus members in grace", () => {
    const member = (consent) => ({ whatsapp_opt_in: consent });
    const rows = [
        { member_status: "expiring", remindable: true, member: member(true) },                          // to remind
        { member_status: "expiring", remindable: true, reminded_at: "2026-11-14", member: member(true) }, // already reminded
        { member_status: "expiring", remindable: false, member: member(true) },                         // ends in 6 days: too early
        { member_status: "expiring", remindable: true, member: member(false) },                         // no consent: cannot be reminded
        { member_status: "in_grace", remindable: true, member: member(true) },                          // in grace
        { member_status: "in_grace", remindable: true, reminded_at: "2026-11-14", member: member(false) } // in grace, reminded or not, still counts
    ];
    const blocked = (m) => m.whatsapp_opt_in !== true;
    assert.equal(renewalsBadgeCount(rows, blocked), 3);
    assert.equal(renewalsBadgeCount([], blocked), 0);
    assert.equal(renewalsBadgeCount(undefined), 0);
});

// ---------- The Renewals page ----------

test("Renewals shows four tabs, the active one marked, with counts once loaded", () => {
    const page = renderRenewalsPage({ tab: "lapsed", counts: { expiring: 5, lapsed: 0, old: null, followups: 12 }, body: "<p>BODY</p>" });
    assert.deepEqual([...page.matchAll(/data-renewals-tab="([a-z]+)"/g)].map((match) => match[1]), RENEWAL_TABS);
    assert.deepEqual([...page.matchAll(/<button class="tab-button[^"]*"[^>]*aria-selected="(true|false)"/g)].map((match) => match[1]), ["false", "true", "false", "false"]);
    assert.match(page, /Expiring soon <span class="count-pill">5</);
    assert.match(page, /Lapsed <span class="count-pill">0</, "zero is shown as 0, not hidden");
    assert.match(page, /Old members<\/button>/, "not loaded yet: no count");
    assert.match(page, /Follow-ups <span class="count-pill">12</);
    assert.match(page, /<h1>Renewals<\/h1>/);
    assert.match(page, /<p>BODY<\/p>/);
    assert.match(page, /role="tabpanel"/);
});

test("each tab has its own description and export button", () => {
    const text = (tab) => renderRenewalsPage({ tab, body: "" });
    assert.match(text("lapsed"), /export-renewals/);
    assert.match(text("old"), /export-renewals/);
    assert.match(text("followups"), /export-retention/);
    assert.equal(/export-/.test(text("expiring")), false);
    assert.match(text("lapsed"), /Grace has run out/);
    assert.match(text("old"), /lapsed-list period/);
    assert.match(text("followups"), /not predictions/);
    assert.match(text("nonsense"), /id="renewals-tab-expiring"[^>]*aria-selected="true"/, "an unknown tab shows the first");
});
