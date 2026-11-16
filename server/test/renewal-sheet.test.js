// The Renew sheet's logic (assets/js/modules/renewSheet.js and assets/js/renewal.js) without a
// browser: the new plan's dates for active, expiring and expired members, the backdate option,
// plan changes, edited prices, partial payments and the balance left, and what the button says.
import test from "node:test";
import assert from "node:assert/strict";
import { installPhotoDom } from "./helpers/fakeDom.js";
import { addDaysISO, hasLaterPlan, planEndDate, renewalBalance, renewalPlan } from "../../assets/js/renewal.js";

// The sheet module reads document when it loads (the modal), so import it with the stub in place.
const boot = installPhotoDom();
const { renewView } = await import("../../assets/js/modules/renewSheet.js");
boot.restore();

const today = "2026-11-16";
const monthly = { id: "plan-m", name: "Monthly", duration_days: 30, price: 1500, is_active: true };
const quarterly = { id: "plan-q", name: "Quarterly", duration_days: 90, price: 4000, is_active: true };
const plans = [monthly, quarterly];
const planEnding = (start, end, extra = {}) => ({ id: `p-${start}`, status: "assigned", plan_id: monthly.id, start_date: start, end_date: end, created_at: `${start}T05:00:00Z`, ...extra });
const view = (memberships, fields = {}) => renewView({ plans, memberships, today, planId: monthly.id, fee: 1500, paid: 1500, method: "cash", ...fields });

// ---------- Dates ----------

test("calendar helpers: a plan's last day counts the start day, and dates cross months and years", () => {
    assert.equal(addDaysISO("2026-12-30", 3), "2027-01-02");
    assert.equal(addDaysISO("2026-03-01", -1), "2026-02-28");
    assert.equal(planEndDate("2026-11-20", 30), "2026-12-19");
    assert.equal(planEndDate("2026-11-20", 1), "2026-11-20");
    assert.equal(planEndDate("2026-01-01", 365), "2026-12-31");
});

test("an expiring member's new plan starts the day after the current one ends", () => {
    const result = view([planEnding("2026-10-18", "2026-11-19")]);
    assert.equal(result.startDate, "2026-11-20");
    assert.equal(result.endDate, "2026-12-19");
    assert.equal(result.choice, "after_current");
    assert.equal(result.canBackdate, false, "no backdate option while the plan is running");
});

test("a plan that ends today still counts as active: the new plan starts tomorrow", () => {
    assert.equal(view([planEnding("2026-10-18", today)]).startDate, "2026-11-17");
});

test("an active member with time left continues from the end, even when asking to backdate", () => {
    const result = view([planEnding("2026-11-01", "2026-11-30")], { backdate: true });
    assert.equal(result.startDate, "2026-12-01");
    assert.equal(result.choice, "after_current");
});

test("an expired member starts today by default and is offered the backdate option", () => {
    const result = view([planEnding("2026-09-20", "2026-10-19")]);
    assert.equal(result.startDate, today);
    assert.equal(result.choice, "today");
    assert.equal(result.canBackdate, true);
    assert.equal(result.backdateStart, "2026-10-20", "the day after the old plan ended");
});

test("the backdate option starts the day after the old plan ended", () => {
    const result = view([planEnding("2026-09-20", "2026-10-19")], { backdate: true });
    assert.equal(result.startDate, "2026-10-20");
    assert.equal(result.endDate, "2026-11-18");
    assert.equal(result.choice, "after_old_plan");
    assert.equal(result.warning, "", "this plan is still running today");
});

test("a backdated plan that would already be over warns that the member stays expired", () => {
    const result = view([planEnding("2026-07-01", "2026-07-30")], { backdate: true });
    assert.equal(result.startDate, "2026-07-31");
    assert.equal(result.endDate, "2026-08-29");
    assert.match(result.warning, /would already have ended on 29 Aug 2026/);
    assert.deepEqual(result.errors, [], "it is a warning, not a block");
});

test("a member with no plan starts today and has no backdate option", () => {
    const result = view([]);
    assert.equal(result.startDate, today);
    assert.equal(result.canBackdate, false);
});

test("cancelled plans do not count, and the plan that ends last decides", () => {
    const cancelled = planEnding("2026-11-10", "2026-12-31", { status: "cancelled" });
    assert.equal(view([cancelled, planEnding("2026-09-20", "2026-10-19")]).choice, "today", "a cancelled plan does not keep the member active");
    const history = [planEnding("2026-08-01", "2026-08-30"), planEnding("2026-10-18", "2026-11-19"), planEnding("2026-09-01", "2026-09-30")];
    assert.equal(view(history).startDate, "2026-11-20");
});

test("a plan queued to start later blocks the renewal with its date", () => {
    const result = view([planEnding("2026-11-01", "2026-11-30"), planEnding("2026-12-01", "2026-12-30")]);
    assert.equal(result.blocked, "future_plan");
    assert.equal(result.queuedStart, "2026-12-01");
    assert.equal(result.request, undefined, "nothing can be sent");
});

// ---------- Plan, price, payment ----------

test("the new plan is whichever one is chosen, with its own length", () => {
    const result = view([planEnding("2026-10-18", "2026-11-19")], { planId: quarterly.id, fee: 4000, paid: 4000 });
    assert.equal(result.plan.name, "Quarterly");
    assert.equal(result.endDate, "2027-02-17", "90 days from 20 Nov");
});

test("an edited price is what is charged; the request carries it", () => {
    const result = view([planEnding("2026-10-18", "2026-11-19")], { fee: 1350, paid: 1350 });
    assert.equal(result.request.total_fees, 1350);
    assert.equal(result.request.amount_paid, 1350);
    assert.equal(result.balance.left, 0);
});

test("a partial payment shows what is left on this renewal and the member's whole balance", () => {
    const result = view([planEnding("2026-10-18", "2026-11-19")], { fee: 1500, paid: 600, outstandingBefore: 500 });
    assert.equal(result.balance.left, 900);
    assert.equal(result.balance.total, 1400, "older dues count too");
    assert.equal(result.label, "Renew and record ₹600");
});

test("paying in full is the default and the button says how much will be recorded", () => {
    const result = view([planEnding("2026-10-18", "2026-11-19")]);
    assert.equal(result.label, "Renew and record ₹1,500");
    assert.deepEqual(result.request, { plan_id: monthly.id, backdate: false, expected_start: "2026-11-20", total_fees: 1500, amount_paid: 1500, method: "cash" });
});

test("paying nothing renews without a payment, and the button says only Renew", () => {
    const result = view([planEnding("2026-10-18", "2026-11-19")], { paid: 0, outstandingBefore: 0 });
    assert.equal(result.label, "Renew");
    assert.equal(result.balance.left, 1500);
    assert.equal(result.request.amount_paid, 0);
});

test("the request tells the server which start the screen showed, and whether it was backdated", () => {
    const result = view([planEnding("2026-09-20", "2026-10-19")], { backdate: true });
    assert.equal(result.request.expected_start, "2026-10-20");
    assert.equal(result.request.backdate, true);
    assert.equal(view([planEnding("2026-09-20", "2026-10-19")]).request.backdate, false);
});

test("a UPI payment sends its reference only when there is one, and only for UPI", () => {
    const base = [planEnding("2026-10-18", "2026-11-19")];
    assert.equal(view(base, { method: "upi", utr: "123456789012" }).request.upi_reference, "123456789012");
    assert.equal(Object.hasOwn(view(base, { method: "upi", utr: "" }).request, "upi_reference"), false);
    assert.equal(Object.hasOwn(view(base, { method: "cash", utr: "123456789012" }).request, "upi_reference"), false);
    assert.equal(view(base, { method: "upi", utr: "1234 5678 9012" }).request.upi_reference, "123456789012", "spaces are ignored");
});

// ---------- What stops the button ----------

test("problems keep the button disabled and nothing can be sent", () => {
    const base = [planEnding("2026-10-18", "2026-11-19")];
    const cases = [
        [{ planId: "" }, /Choose a plan/],
        [{ fee: "" }, /price/],
        [{ fee: "-5" }, /price/],
        [{ paid: "" }, /amount paid/],
        [{ paid: "-1" }, /amount paid/],
        [{ fee: 1000, paid: 1500 }, /cannot be more than the price/],
        [{ method: "upi", utr: "12345" }, /12 digits/]
    ];
    for (const [fields, message] of cases) {
        const result = view(base, fields);
        assert.match(result.errors[0], message, JSON.stringify(fields));
        assert.equal(result.request, null, JSON.stringify(fields));
    }
});

test("a UTR is only checked for a UPI payment of more than nothing", () => {
    const base = [planEnding("2026-10-18", "2026-11-19")];
    assert.deepEqual(view(base, { method: "cash", utr: "12345" }).errors, []);
    assert.deepEqual(view(base, { method: "upi", paid: 0, utr: "12345" }).errors, []);
});

test("an inactive or unknown plan is not offered", () => {
    assert.match(view([], { planId: "plan-old" }).errors[0], /Choose a plan/);
});

// ---------- Shared rules ----------

test("hasLaterPlan: renewed means a plan is queued after the current one, not just any other plan", () => {
    const current = planEnding("2026-10-18", "2026-11-19");
    assert.equal(hasLaterPlan([current], current), false);
    assert.equal(hasLaterPlan([current, planEnding("2026-11-20", "2026-12-19")], current), true);
    assert.equal(hasLaterPlan([current, planEnding("2026-08-01", "2026-09-01")], current), false, "an older plan does not count");
    assert.equal(hasLaterPlan([current, planEnding("2026-11-20", "2026-12-19", { status: "cancelled" })], current), false);
    assert.equal(hasLaterPlan([], null), false);
});

test("renewalBalance never goes negative and rounds to paise", () => {
    assert.deepEqual(renewalBalance({ fee: 1500, paid: 1500, outstandingBefore: 0 }), { left: 0, total: 0 });
    assert.deepEqual(renewalBalance({ fee: 1000.1, paid: 400.05, outstandingBefore: 0.2 }), { left: 600.05, total: 600.25 });
    assert.deepEqual(renewalBalance({ fee: 100, paid: 150 }), { left: 0, total: 0 });
});

test("renewalPlan reports the queued plan's date and ignores the order of the history", () => {
    const list = [planEnding("2026-12-01", "2026-12-30"), planEnding("2026-11-01", "2026-11-30")];
    assert.equal(renewalPlan(list, today).queuedStart, "2026-12-01");
    assert.equal(renewalPlan([...list].reverse(), today).queuedStart, "2026-12-01");
});
