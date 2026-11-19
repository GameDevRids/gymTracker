// Stage 3 of the live-app review: the Today page. Needs attention first, a slim Get started, three
// header actions, no plan donut or "keep an eye on" table, and a small greeting.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installPhotoDom } from "./helpers/fakeDom.js";

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const boot = installPhotoDom();
const { holdsEndingThisWeek, renderDashboard, todayHeading } = await import("../../assets/js/modules/dashboard.js");
const { setupMode, setupSteps, SLIM_AFTER } = await import("../../assets/js/modules/setupChecklist.js");
const { gymSummary } = await import("../../assets/js/modules/summary.js");
const { state, memberFromApiRow } = await import("../../assets/js/state.js");
boot.restore();

const TODAY = "2026-11-20";
const summary = { total_members: 4, new_members_this_month: 1, collected_this_month: 1000, collected_all_time: 1000, outstanding_total: 0, members_with_balance: 0, status_counts: { expiring: 0, in_grace: 0 }, inactive_members: 0, months: [], active_by_plan: [{ plan_name: "Monthly", members: 3 }] };

test("the header has Check in, Record payment and Add member, with Add member the only marigold one", () => {
    const html = todayHeading("Iron Den");
    const buttons = [...html.matchAll(/<button class="button (button-[a-z]+)" type="button" (data-[a-z]+="[a-z-]+")>([^<]+)</g)].map((m) => [m[1], m[2], m[3]]);
    assert.deepEqual(buttons, [
        ["button-secondary", 'data-view="scan"', "Check in"],
        ["button-secondary", 'data-action="record-payment"', "Record payment"],
        ["button-primary", 'data-action="add-member"', "＋ Add member"]
    ]);
    assert.doesNotMatch(html, /export-members|enquiry-add|quick-add-member|✦/);
});

test("Today: Needs attention first, no plan donut and no 'keep an eye on' table; stats and feed stay", () => {
    gymSummary.status = "ready";
    gymSummary.data = summary;
    state.members = [];
    state.attendance = [];
    const html = renderDashboard();
    const order = ["All caught up for today", "kpi-grid", "Recent activity"].map((text) => html.indexOf(text));
    assert.ok(order.every((index) => index > 0), "all three are there");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "in that order");
    assert.doesNotMatch(html, /dashboard-plan-chart|Membership-plan distribution|Memberships to keep an eye on/);
    assert.match(readFileSync(new URL("../../assets/js/modules/operations.js", import.meta.url), "utf8"), /Plan popularity/, "the donut lives on Reports");
});

test("holds ending this week count members on hold coming back within 7 days", () => {
    const held = (back) => memberFromApiRow({ id: `m-${back}`, full_name: "Asha", member_status: "on_hold", status_detail: { hold: { id: "h", return_by: back } } });
    const members = [held("2026-11-22"), held("2026-11-27"), held("2026-11-28"), held(""), memberFromApiRow({ id: "a", member_status: "active", status_detail: {} })];
    assert.equal(holdsEndingThisWeek(members, TODAY), 2);
    assert.match(readFileSync(new URL("../../assets/js/main.js", import.meta.url), "utf8"), /view === "members" && MEMBER_FILTERS\.includes\(tab\)/, "the card opens Members filtered to On hold");
});

// ---------- Get started ----------

const steps = (doneCount, total = 6) => Array.from({ length: total }, (_, index) => ({ done: index < doneCount, title: `Step ${index + 1}` }));

test("Get started: full card under 3 done, one slim line from 3, hidden when all done", () => {
    assert.equal(SLIM_AFTER, 3);
    assert.equal(setupMode(steps(2)), "full");
    assert.equal(setupMode(steps(3)), "slim");
    assert.equal(setupMode(steps(5)), "slim");
    assert.equal(setupMode(steps(6)), "hidden");
});

test("Get started has a gym phone step that opens Settings › Gym details", () => {
    state.gym = { ...state.gym, phone: "", upiId: "" };
    const phone = setupSteps(summary).find((step) => step.title === "Add your gym's phone number");
    assert.ok(phone);
    assert.equal(phone.done, false);
    assert.deepEqual([phone.view, phone.tab], ["settings", "details"]);
    state.gym.phone = "9876543210";
    assert.equal(setupSteps(summary).find((step) => step.title === "Add your gym's phone number").done, true);
    assert.equal(setupSteps(summary).length, 6);
});

test("the slim line names the steps left and links to the next one", () => {
    const source = readFileSync(new URL("../../assets/js/modules/setupChecklist.js", import.meta.url), "utf8");
    assert.match(source, /\$\{left\} step\$\{left === 1 \? "" : "s"\} left:/);
    assert.match(source, /class="setup-slim"/);
});
