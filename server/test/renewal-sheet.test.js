// The Renew sheet's logic (assets/js/modules/renewSheet.js and assets/js/renewal.js) without a
// browser: start dates before and after the plan ends and why, the owner's own date, the grace that
// follows, the welcome-back offer, plan changes, edited prices, partial payments and the button.
import test from "node:test";
import assert from "node:assert/strict";
import { installPhotoDom } from "./helpers/fakeDom.js";
import { addDaysISO, planEndDate, planGraceDays, renewalBalance, renewalPlan, startDateProblem, suggestedGraceDays, welcomeBackDiscount } from "../../assets/js/renewal.js";

// The sheet module reads document when it loads (the modal), so import it with the stub in place.
const boot = installPhotoDom();
const { renewView } = await import("../../assets/js/modules/renewSheet.js");
boot.restore();

const today = "2026-11-17";
const monthly = { id: "plan-m", name: "Monthly", duration_days: 30, price: 1500, grace_days: null, is_active: true };
const quarterly = { id: "plan-q", name: "Quarterly", duration_days: 90, price: 4000, grace_days: 4, is_active: true };
const plans = [monthly, quarterly];
const settings = { expiry_grace_days: 3, welcome_back_discount_type: "percent", welcome_back_discount_value: 10, lapsed_list_days: 60 };
const plan = (start, end, extra = {}) => ({ id: `p-${start}`, status: "assigned", plan_id: monthly.id, start_date: start, end_date: end, grace_days: 3, created_at: `${start}T05:00:00Z`, ...extra });
const view = (memberships, fields = {}) => renewView({ plans, memberships, today, planId: monthly.id, fee: 1500, paid: 1500, method: "cash", settings, ...fields });

// ---------- Start dates ----------

test("calendar helpers: a plan's last day counts the start day, across months and years", () => {
    assert.equal(addDaysISO("2026-12-30", 3), "2027-01-02");
    assert.equal(planEndDate("2026-11-20", 30), "2026-12-19");
    assert.equal(planEndDate("2026-01-01", 365), "2026-12-31");
});

test("renewing before the plan ends: starts the day after it ends, and says why", () => {
    const result = view([plan("2026-10-21", "2026-11-19")]);
    assert.equal(result.startDate, "2026-11-20");
    assert.equal(result.endDate, "2026-12-19");
    assert.match(result.why, /after the current plan ends/);
    assert.equal(result.request.expected_start, "2026-11-20");
    assert.equal(Object.hasOwn(result.request, "start_date"), false, "the automatic date is not sent as the owner's");
});

test("a plan ending today still counts as running: the new plan starts tomorrow", () => {
    assert.equal(view([plan("2026-10-19", today)]).startDate, "2026-11-18");
});

for (const [label, end] of [["in grace", "2026-11-15"], ["lapsed", "2026-10-20"], ["old", "2026-06-01"]]) {
    test(`renewing ${label}: starts today, full length, the gap is forgiven`, () => {
        const result = view([plan("2026-01-01", end)]);
        assert.equal(result.startDate, today);
        assert.equal(result.endDate, "2026-12-16");
        assert.match(result.why, new RegExp(`Starts today – plan ended on`));
    });
}

test("a member with no plan starts today", () => {
    const result = view([]);
    assert.equal(result.startDate, today);
    assert.equal(result.why, "Starts today.");
});

test("the owner can choose another start date; it is sent and explained", () => {
    const result = view([plan("2026-01-01", "2026-10-20")], { startDate: "2026-11-10" });
    assert.equal(result.startDate, "2026-11-10");
    assert.equal(result.endDate, "2026-12-09");
    assert.equal(result.ownerDate, true);
    assert.equal(result.why, "Start date chosen by you.");
    assert.equal(result.request.start_date, "2026-11-10");
    assert.equal(result.request.expected_start, today, "the server still checks the automatic date it would have used");
});

test("an owner date that overlaps the running plan is refused before anything is sent", () => {
    const result = view([plan("2026-10-21", "2026-11-19")], { startDate: "2026-11-15" });
    assert.match(result.errors[0], /overlaps a plan/);
    assert.equal(result.request, null);
});

test("choosing the automatic date again is the same as not choosing one", () => {
    const result = view([plan("2026-10-21", "2026-11-19")], { startDate: "2026-11-20" });
    assert.equal(result.ownerDate, false);
    assert.equal(Object.hasOwn(result.request, "start_date"), false);
});

test("a plan already booked to start later blocks the renewal", () => {
    const result = view([plan("2026-10-21", "2026-11-19"), plan("2026-11-20", "2026-12-19")]);
    assert.equal(result.blocked, "future_plan");
    assert.equal(result.queuedStart, "2026-11-20");
});

// ---------- Grace ----------

test("the new plan's grace: the plan's own, else the gym default; shown as grace till", () => {
    const usesGym = view([plan("2026-10-21", "2026-11-19")]);
    assert.equal(usesGym.graceDays, 3);
    assert.equal(usesGym.graceUntil, "2026-12-22");
    const ownGrace = view([plan("2026-10-21", "2026-11-19")], { planId: quarterly.id, fee: 4000, paid: 4000 });
    assert.equal(ownGrace.graceDays, 4);
    assert.equal(ownGrace.graceUntil, addDaysISO(ownGrace.endDate, 4));
    assert.equal(planGraceDays({ grace_days: 0 }, 3), 0, "0 on a plan means no grace, not the gym default");
});

test("Use suggested: monthly 3, quarterly 4, six-month and yearly 5", () => {
    assert.deepEqual([30, 31, 90, 180, 365].map(suggestedGraceDays), [3, 3, 4, 5, 5]);
});

// ---------- Welcome back ----------

test("welcome back is offered to lapsed and old members only, with the gym's discount", () => {
    assert.equal(view([plan("2026-01-01", "2026-10-20")]).welcomeBack.offered, true, "lapsed");
    assert.equal(view([plan("2026-01-01", "2026-06-01")]).welcomeBack.offered, true, "old");
    assert.equal(view([plan("2026-10-01", "2026-11-15")]).welcomeBack.offered, false, "in grace");
    assert.equal(view([plan("2026-10-21", "2026-11-19")]).welcomeBack.offered, false, "expiring");
    assert.equal(view([plan("2026-01-01", "2026-10-20")]).welcomeBack.amount, 150, "10% of ₹1,500");
    assert.equal(view([plan("2026-01-01", "2026-10-20")], { settings: { ...settings, welcome_back_discount_value: 0 } }).welcomeBack.offered, false, "not set: no button");
});

test("with welcome back on, the request carries the reduced price and the reason", () => {
    const result = view([plan("2026-01-01", "2026-10-20")], { welcomeBack: true, fee: 1350, paid: 1350 });
    assert.equal(result.request.total_fees, 1350);
    assert.equal(result.request.discount_reason, "welcome_back");
    const fullPrice = view([plan("2026-01-01", "2026-10-20")], { welcomeBack: true, fee: 1500, paid: 1500 });
    assert.equal(Object.hasOwn(fullPrice.request, "discount_reason"), false, "no discount, no reason");
});

test("welcomeBackDiscount: amount or percent, never more than the price", () => {
    assert.equal(welcomeBackDiscount(1500, { welcome_back_discount_type: "amount", welcome_back_discount_value: 200 }), 200);
    assert.equal(welcomeBackDiscount(150, { welcome_back_discount_type: "amount", welcome_back_discount_value: 200 }), 150);
    assert.equal(welcomeBackDiscount(1499, { welcome_back_discount_type: "percent", welcome_back_discount_value: 15 }), 224.85);
    assert.equal(welcomeBackDiscount(1500, {}), 0);
});

// ---------- Plan, price, payment ----------

test("a different plan, with its own length", () => {
    const result = view([plan("2026-10-21", "2026-11-19")], { planId: quarterly.id, fee: 4000, paid: 4000 });
    assert.equal(result.plan.name, "Quarterly");
    assert.equal(result.endDate, "2027-02-17");
});

test("a partial payment shows what is left on this renewal and the member's whole balance", () => {
    const result = view([plan("2026-10-21", "2026-11-19")], { fee: 1500, paid: 600, outstandingBefore: 500 });
    assert.deepEqual(result.balance, { left: 900, total: 1400 });
    assert.equal(result.label, "Renew and record ₹600");
});

test("paying nothing renews without a payment, and the button says only Renew", () => {
    const result = view([plan("2026-10-21", "2026-11-19")], { paid: 0 });
    assert.equal(result.label, "Renew");
    assert.equal(result.request.amount_paid, 0);
});

test("a UPI reference is sent only for UPI, and spaces are ignored", () => {
    const base = [plan("2026-10-21", "2026-11-19")];
    assert.equal(view(base, { method: "upi", utr: "1234 5678 9012" }).request.upi_reference, "123456789012");
    assert.equal(Object.hasOwn(view(base, { method: "cash", utr: "123456789012" }).request, "upi_reference"), false);
});

test("problems keep the button disabled and nothing can be sent", () => {
    const base = [plan("2026-10-21", "2026-11-19")];
    for (const [fields, message] of [
        [{ planId: "" }, /Choose a plan/], [{ fee: "-5" }, /price/], [{ paid: "" }, /amount paid/],
        [{ fee: 1000, paid: 1500 }, /cannot be more than the price/], [{ method: "upi", utr: "12345" }, /12 digits/]
    ]) {
        const result = view(base, fields);
        assert.match(result.errors[0], message, JSON.stringify(fields));
        assert.equal(result.request, null);
    }
});

// ---------- Shared helpers ----------

test("renewalPlan ignores cancelled plans and the order of the history", () => {
    const cancelled = plan("2026-11-10", "2026-12-31", { status: "cancelled" });
    assert.equal(renewalPlan([cancelled, plan("2026-01-01", "2026-10-20")], today).choice, "today");
    const history = [plan("2026-08-01", "2026-08-30"), plan("2026-10-21", "2026-11-19"), plan("2026-09-01", "2026-09-30")];
    assert.equal(renewalPlan(history, today).startDate, "2026-11-20");
});

test("startDateProblem and renewalBalance", () => {
    assert.equal(startDateProblem([plan("2026-10-21", "2026-11-19")], "2026-11-20", 30), "");
    assert.match(startDateProblem([], "", 30), /Choose a start date/);
    assert.deepEqual(renewalBalance({ fee: 1000.1, paid: 400.05, outstandingBefore: 0.2 }), { left: 600.05, total: 600.25 });
});
