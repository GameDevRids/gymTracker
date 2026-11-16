// Plan holds above the database (which hold-migration.test.js covers): the shared rule
// (assets/js/memberStatus.js and assets/js/holds.js), the "Put plan on hold" sheet's logic, check-in
// while on hold (staff, "Resume and check in", the poster), the lists, renewing, the API handlers,
// validation, the welcome back message and the plan balance.
import test from "node:test";
import assert from "node:assert/strict";
import { applyHolds, checkInDecision, memberStatusFor, remindable } from "../../assets/js/memberStatus.js";
import { defaultHoldLimits, holdDates, holdEligibility, holdLimits, holdLimitsText, holdReturnProblem, holdStartProblem } from "../../assets/js/holds.js";
import { buildHoldReturnMessage } from "../../assets/js/holdMessage.js";
import { installPhotoDom } from "./helpers/fakeDom.js";
import { fakeCheckinDb, gymA, gymB, ids, owner } from "./helpers/fakeCheckinDb.js";
import { fakeStatusDb, statusGym } from "./helpers/fakeStatusDb.js";
import { countStatuses, listExpiring, listLapsed, memberStatuses } from "../services/memberStatusService.js";
import { manualCheckIn, scanCheckIn } from "../services/attendanceService.js";
import { approveDevice, entranceCheckIn, hashDeviceSecret, newDeviceSecret, requestLink } from "../services/entranceService.js";
import { HoldError, holdDatabaseError, resumeHold, startHold } from "../services/holdsService.js";
import { renewMember } from "../services/renewalsService.js";
import { memberBilling } from "../services/membersService.js";
import { createHoldHandlers } from "../controllers/holdsController.js";
import { validateHoldPayload } from "../middleware/validateHold.js";
import { validateRenewalSettings } from "../middleware/validateRenewal.js";
import { validatePlanPayload } from "../middleware/validatePlan.js";
import { validateManualCheckIn } from "../middleware/validateAttendance.js";
import { validateMessagePayload } from "../middleware/validateWhatsAppMessage.js";

// The sheet module reads document and the saved language when it loads.
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };
const boot = installPhotoDom();
const { holdSheetView, resumeView } = await import("../../assets/js/modules/holds.js");
boot.restore();

const today = "2026-11-12";
const plan = (id, start, end, extra = {}) => ({ id, status: "assigned", plan_name: "Quarterly", duration_days: 90, grace_days: 3, start_date: start, end_date: end, created_at: `${start}T05:00:00Z`, ...extra });
const hold = (extra = {}) => ({ id: "h1", membership_id: "q", starts_on: "2026-11-05", planned_return_on: null, latest_return_on: "2026-12-05", remaining_days: 26, end_before: "2026-11-30", ...extra });

function run(middleware, body) {
    const request = { body, params: {} };
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
    let passed = false;
    middleware(request, response, () => { passed = true; });
    return { passed, request, response };
}

// ---------- The shared status rule ----------

test("on hold beats every other status: expiring, in grace and lapsed alike", () => {
    for (const [label, end] of [["expiring", "2026-11-15"], ["in grace", "2026-11-10"], ["lapsed", "2026-10-01"]]) {
        const state = memberStatusFor([plan("q", "2026-08-01", end)], today, { holds: [hold({ starts_on: "2026-07-20", latest_return_on: "2026-12-20", end_before: end })] });
        assert.equal(state.status, "on_hold", label);
        assert.equal(state.hold.starts_on, "2026-07-20");
        assert.equal(remindable(state), false, "no reminders while on hold");
    }
});

test("the hold's details: since when, back by when, and the end date if resumed today", () => {
    const state = memberStatusFor([plan("q", "2026-09-01", "2026-11-30")], today, { holds: [hold({ planned_return_on: "2026-11-25" })] });
    assert.deepEqual([state.hold.starts_on, state.hold.planned_return_on, state.hold.open_ended, state.hold.days_held_so_far, state.hold.end_if_resumed_today],
        ["2026-11-05", "2026-11-25", false, 7, "2026-12-07"]);
});

test("a hold booked to start later leaves the status alone and is shown as booked", () => {
    const state = memberStatusFor([plan("q", "2026-09-01", "2026-11-30")], today, { holds: [hold({ starts_on: "2026-11-20", latest_return_on: "2026-12-20", remaining_days: 11 })] });
    assert.equal(state.status, "active");
    assert.equal(state.hold, null);
    assert.equal(state.scheduledHold.starts_on, "2026-11-20");
});

test("from dates only: a hold whose return date passed has ended, and the plan (and a booked one) moved", () => {
    const plans = [plan("q", "2026-09-01", "2026-11-30"), plan("next", "2026-12-01", "2027-02-28")];
    const ended = hold({ starts_on: "2026-11-01", planned_return_on: "2026-11-10", latest_return_on: "2026-12-01", remaining_days: 30 });
    const applied = applyHolds(plans, [ended], today);
    assert.equal(applied.onHold, null);
    assert.deepEqual(applied.settled, [{ id: "h1", ended_on: "2026-11-10", days_held: 9, reason: "return_date" }]);
    assert.deepEqual(applied.memberships.map((row) => [row.start_date, row.end_date]), [["2026-09-01", "2026-12-09"], ["2026-12-10", "2027-03-09"]]);
    assert.equal(memberStatusFor(plans, today, { holds: [ended] }).status, "active");
    // Once the saved dates have moved, applying the hold again changes nothing.
    const saved = [plan("q", "2026-09-01", "2026-12-09"), plan("next", "2026-12-10", "2027-03-09")];
    assert.deepEqual(applyHolds(saved, [ended], today).memberships.map((row) => row.end_date), ["2026-12-09", "2027-03-09"]);
});

test("an open-ended hold ends by itself when its maximum runs out", () => {
    const applied = applyHolds([plan("q", "2026-09-01", "2026-11-30")], [hold({ starts_on: "2026-10-01", latest_return_on: "2026-10-31", remaining_days: 61 })], today);
    assert.deepEqual(applied.settled[0], { id: "h1", ended_on: "2026-10-31", days_held: 30, reason: "max_days" });
    assert.equal(applied.memberships[0].end_date, "2026-12-30");
});

test("on hold is not checked in until the plan is resumed", () => {
    assert.deepEqual(checkInDecision("on_hold"), { result: "on_hold", allowed: false, stored: "none" });
});

// ---------- Limits, eligibility and dates ----------

test("default limits by plan length match the database's", () => {
    // The same lengths and answers as hold-migration.test.js checks in SQL.
    const lengths = [30, 31, 32, 90, 100, 101, 180, 190, 191, 365];
    assert.deepEqual(lengths.map((days) => [days, defaultHoldLimits(days).maxHoldDays, defaultHoldLimits(days).maxHolds]),
        [[30, 30, 0], [31, 30, 0], [32, 30, 1], [90, 30, 1], [100, 30, 1], [101, 30, 2], [180, 30, 2], [190, 30, 2], [191, 60, 2], [365, 60, 2]]);
    assert.deepEqual(holdLimits({ max_hold_days: 10, max_holds: null }, 365), { maxHoldDays: 10, maxHolds: 2, defaultMaxHoldDays: 60, defaultMaxHolds: 2 });
    assert.equal(holdLimitsText(defaultHoldLimits(30)), "no holds");
    assert.equal(holdLimitsText(defaultHoldLimits(90)), "up to 30 days, 1 hold");
});

test("who can be held, and the reason when not", () => {
    const running = plan("q", "2026-09-01", "2026-11-30");
    const check = (fields) => holdEligibility({ status: "active", membership: running, plan: null, holds: [], settings: {}, today, ...fields });
    assert.equal(check({}).allowed, true);
    assert.equal(check({}).left, 1);
    assert.equal(check({ status: "expiring" }).allowed, true);
    assert.equal(check({ membership: { ...running, plan_name: "Monthly", duration_days: 30 } }).reason, "Monthly plans can't be put on hold.");
    assert.equal(check({ holds: [{ membership_id: "q", cancelled: false }] }).reason, "The hold on this plan is already used.");
    assert.equal(check({ holds: [{ membership_id: "q", cancelled: true }] }).allowed, true, "a cancelled hold gives the hold back");
    const six = { ...running, duration_days: 180 };
    assert.equal(check({ membership: six, holds: [{ membership_id: "q" }, { membership_id: "q" }] }).reason, "Both holds already used.");
    for (const status of ["in_grace", "lapsed", "old", "upcoming", "none", "on_hold"]) assert.equal(check({ status }).allowed, false, status);
    assert.equal(check({ settings: { hold_fee_enabled: true, hold_fee_amount: 200 } }).fee, 200);
    assert.equal(check({ settings: { hold_fee_enabled: false, hold_fee_amount: 200 } }).fee, 0);
});

test("return dates: at least the gym's minimum, at most the plan's maximum; 0 means no minimum", () => {
    assert.match(holdReturnProblem("2026-11-12", "2026-11-20", { minHoldDays: 15, maxHoldDays: 30 }), /at least 15 days/);
    assert.match(holdReturnProblem("2026-11-12", "2026-12-13", { minHoldDays: 15, maxHoldDays: 30 }), /at most 30 days/);
    assert.equal(holdReturnProblem("2026-11-12", "2026-11-27", { minHoldDays: 15, maxHoldDays: 30 }), "");
    assert.equal(holdReturnProblem("2026-11-12", "2026-11-13", { minHoldDays: 0, maxHoldDays: 30 }), "");
    assert.match(holdReturnProblem("2026-11-12", "2026-11-12", { minHoldDays: 0, maxHoldDays: 30 }), /at least 1 days/);
    assert.match(holdStartProblem("2026-11-11", { today, planEnd: "2026-11-30" }), /between today/);
    assert.match(holdStartProblem("2026-12-01", { today, planEnd: "2026-11-30" }), /between today/);
    assert.equal(holdStartProblem("2026-11-30", { today, planEnd: "2026-11-30" }), "");
});

test("remaining days and the new end: ends 31 March, hold 1 March, back 4 March -> 3 April", () => {
    assert.deepEqual(holdDates({ endBefore: "2027-03-31", startsOn: "2027-03-01", resumeOn: "2027-03-04" }), { remainingDays: 31, daysHeld: 3, endAfter: "2027-04-03" });
    // The same as resume day + remaining days - 1.
    assert.deepEqual(holdDates({ endBefore: "2027-03-31", startsOn: "2027-03-01", resumeOn: "2027-03-01" }), { remainingDays: 31, daysHeld: 0, endAfter: "2027-03-31" });
});

// ---------- The "Put plan on hold" sheet ----------

const eligibility = (extra = {}) => ({ allowed: true, reason: "", limits: { maxHoldDays: 30, maxHolds: 1 }, left: 1, minHoldDays: 15, fee: 0, ...extra });
const sheet = (fields = {}) => holdSheetView({ eligibility: eligibility(fields.eligibility), membership: plan("q", "2026-09-01", "2026-11-30"), today, ...fields, ...(fields.eligibility ? { eligibility: eligibility(fields.eligibility) } : {}) });

test("the sheet: not allowed shows the reason and sends nothing", () => {
    const view = holdSheetView({ eligibility: { allowed: false, reason: "Both holds already used." }, membership: plan("q", "2026-09-01", "2026-11-30"), today });
    assert.equal(view.allowed, false);
    assert.equal(view.reason, "Both holds already used.");
    assert.equal(view.request, null);
});

test("the sheet: today by default, a return date is required, and its limits are checked", () => {
    assert.match(sheet().errors[0], /Choose the return date/);
    assert.match(sheet({ returnOn: "2026-11-20" }).errors[0], /at least 15 days/);
    assert.match(sheet({ returnOn: "2026-12-20" }).errors[0], /at most 30 days/);
    const ok = sheet({ returnOn: "2026-11-27" });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.request, { starts_on: today, planned_return_on: "2026-11-27" });
    assert.equal(ok.remainingDays, 19);
    assert.match(ok.preview, /plan ends on/);
    assert.deepEqual([ok.minReturn, ok.maxReturn], ["2026-11-27", "2026-12-12"]);
    assert.equal(ok.label, "Put plan on hold");
});

test("the sheet: until they come back sends no return date; a later start says the plan keeps running", () => {
    const open = sheet({ returnMode: "open" });
    assert.deepEqual(open.request, { starts_on: today, planned_return_on: null });
    assert.match(open.preview, /ends by itself after 30 days/);
    const later = sheet({ returnMode: "open", startsOn: "2026-11-20" });
    assert.match(later.preview, /until then the plan keeps running/);
    assert.match(sheet({ returnMode: "open", startsOn: "2026-12-01" }).errors[0], /between today/);
});

test("the sheet: with a hold fee the button names it and the payment method is sent", () => {
    const view = sheet({ returnMode: "open", method: "upi", utr: "1234 5678 9012", eligibility: { fee: 200 } });
    assert.match(view.label, /Put on hold and record ₹200/);
    assert.deepEqual(view.request, { starts_on: today, planned_return_on: null, method: "upi", upi_reference: "123456789012" });
    assert.match(sheet({ returnMode: "open", method: "upi", utr: "123", eligibility: { fee: 200 } }).errors[0], /12 digits/);
    assert.equal(Object.hasOwn(sheet({ returnMode: "open", method: "cash" }).request, "method"), false, "no fee, no payment");
});

test("resuming today: days held, the new end date and its grace", () => {
    assert.deepEqual(resumeView({ hold: hold(), today, graceDays: 3 }), { daysHeld: 7, newEnd: "2026-12-07", graceUntil: "2026-12-10", graceDays: 3 });
});

// ---------- Lists and counts ----------

test("members on hold are left off Expiring soon and the Lapsed lists, and counted as on hold", async () => {
    const member = (id, name) => ({ id, full_name: name, phone: "9876543210", whatsapp_opt_in: true });
    const db = fakeStatusDb({
        members: [member("a", "On hold, plan ending"), member("b", "On hold, plan ended"), member("c", "Expiring")],
        memberships: [
            plan("pa", "2026-09-01", "2026-11-14", { member_id: "a" }),
            plan("pb", "2026-07-01", "2026-09-28", { member_id: "b" }),
            plan("pc", "2026-09-01", "2026-11-14", { member_id: "c" })
        ],
        holds: [
            hold({ id: "ha", member_id: "a", membership_id: "pa", end_before: "2026-11-14" }),
            hold({ id: "hb", member_id: "b", membership_id: "pb", starts_on: "2026-09-01", latest_return_on: "2026-12-01", end_before: "2026-09-28" })
        ]
    });
    assert.deepEqual((await listExpiring(statusGym, db, today)).map((row) => row.member.full_name), ["Expiring"]);
    assert.deepEqual(await listLapsed(statusGym, "lapsed", db, today), []);
    assert.deepEqual(await listLapsed(statusGym, "old", db, today), []);
    const counts = countStatuses(await memberStatuses(statusGym, db, today));
    assert.equal(counts.on_hold, 2);
    assert.ok(db.rpcs.some(([name, args]) => name === "gympulse_settle_holds" && args.p_gym_id === statusGym), "due holds are saved before statuses are worked out");
    assert.ok(db.queries.filter((query) => query.table === "membership_holds").every((query) => query.filters.some(([kind, column, value]) => kind === "eq" && column === "gym_id" && value === statusGym)));
});

// ---------- Check-in ----------

const TODAY = "2026-11-12";
const morning = new Date("2026-11-12T02:12:00Z");

/** Adds a holds table and the two hold functions check-in uses to the check-in fake database. */
function withHolds(db, rows) {
    db.tables.membership_holds = rows.map((row) => ({ gym_id: gymA, cancelled: false, ended_on: null, end_reason: null, days_held: null, end_after: null, ...row }));
    db.rpcs = [];
    db.rpc = (name, args) => {
        db.rpcs.push([name, args]);
        if (name === "gympulse_settle_holds") return Promise.resolve({ data: 0, error: null });
        if (name !== "gympulse_resume_hold") return Promise.resolve({ data: null, error: { code: "42883" } });
        const found = db.tables.membership_holds.find((row) => row.id === args.p_hold_id && row.gym_id === args.p_gym_id);
        if (!found) return Promise.resolve({ data: null, error: { code: "P0002", message: "Hold not found." } });
        const dates = holdDates({ endBefore: found.end_before, startsOn: found.starts_on, resumeOn: TODAY });
        Object.assign(found, { ended_on: TODAY, end_reason: args.p_reason, days_held: dates.daysHeld, end_after: dates.endAfter });
        const membership = db.tables.member_memberships.find((row) => row.id === found.membership_id);
        membership.end_date = dates.endAfter;
        return Promise.resolve({ data: { replayed: false, hold: { ...found }, membership: { ...membership }, payment: null, moved_plans: [] }, error: null });
    };
    return db;
}
// Riya's plan runs 1–30 Nov; she went on hold on 5 Nov (26 days kept).
const riyaHold = { id: "00000000-0000-4000-8000-0000000000c1", member_id: ids.riya, membership_id: "ms-riya", starts_on: "2026-11-05", planned_return_on: null, latest_return_on: "2026-12-05", remaining_days: 26, end_before: "2026-11-30" };

test("staff check-in (QR or manual) of a member on hold: not checked in, with the hold's start", async () => {
    const db = withHolds(fakeCheckinDb(), [riyaHold]);
    const token = db.tables.members.find((member) => member.id === ids.riya).qr_token;
    for (const result of [await scanCheckIn(token, gymA, owner, db, morning), await manualCheckIn(ids.riya, gymA, owner, db, morning)]) {
        assert.deepEqual([result.result, result.blocked, result.recorded, result.member_status], ["on_hold", true, false, "on_hold"]);
        assert.equal(result.hold.starts_on, "2026-11-05");
        assert.equal(result.renewal_price, null, "no renewal is asked for");
    }
    assert.deepEqual(db.tables.attendance, []);
    assert.equal(db.rpcs.some(([name]) => name === "gympulse_resume_hold"), false, "staff check-in never resumes by itself");
});

test("Resume and check in: the hold ends today, the plan moves later, and the member is checked in", async () => {
    const db = withHolds(fakeCheckinDb(), [riyaHold]);
    const result = await manualCheckIn(ids.riya, gymA, owner, db, morning, { resumeHold: true });
    assert.deepEqual([result.result, result.recorded], ["checked_in", true]);
    assert.equal(result.resumed.new_end_date, "2026-12-07", "30 Nov + 7 days held");
    assert.equal(result.membership.end_date, "2026-12-07");
    assert.deepEqual(db.rpcs.find(([name]) => name === "gympulse_resume_hold")[1], { p_gym_id: gymA, p_hold_id: riyaHold.id, p_reason: "check_in", p_by: owner });
    assert.deepEqual(db.tables.attendance.map((row) => [row.member_id, row.membership_status_at_check_in]), [[ids.riya, "active"]]);
});

test("the entrance poster resumes the hold by itself and says the new end date", async () => {
    const db = withHolds(fakeCheckinDb({ gyms: { a: { checkin_method: "entrance_poster" }, b: { checkin_method: "entrance_poster" } } }), [riyaHold]);
    const gym = db.tables.gyms.find((row) => row.id === gymA);
    const secret = newDeviceSecret();
    await requestLink(gym, secret, "9876543210", { now: morning }, db);
    for (const row of db.tables.member_devices.filter((device) => device.device_secret_hash === hashDeviceSecret(secret))) await approveDevice(row.id, gymA, owner, db, morning);
    const result = await entranceCheckIn(gym, secret, { now: morning }, db);
    assert.equal(result.result, "checked_in");
    assert.deepEqual(result.resumed, { new_end_date: "2026-12-07", days_held: 7 });
    assert.equal(db.tables.membership_holds[0].end_reason, "check_in");
    assert.equal(db.tables.attendance[0].method, "entrance_poster");
});

test("Resume and check in is accepted only as a true/false flag on manual check-in", () => {
    const ok = run(validateManualCheckIn, { member_id: ids.riya, resume_hold: true });
    assert.equal(ok.passed, true);
    assert.equal(ok.request.checkInResumeHold, true);
    assert.equal(run(validateManualCheckIn, { member_id: ids.riya }).request.checkInResumeHold, false);
    assert.equal(run(validateManualCheckIn, { member_id: ids.riya, resume_hold: "yes" }).passed, false);
});

// ---------- The holds service and API ----------

test("starting a hold sends the gym and the staff member from the sign-in, never from the request", async () => {
    const calls = [];
    const client = { rpc: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: { replayed: false, hold: { id: "h" }, membership: { start_date: "2026-11-01", end_date: "2026-11-30", status: "assigned" } }, error: null }); } };
    await startHold(ids.riya, { idempotency_key: "k", starts_on: today, planned_return_on: null, method: "cash" }, { gymId: gymA, userId: owner }, client);
    assert.deepEqual(calls[0], ["gympulse_start_hold", { p_gym_id: gymA, p_member_id: ids.riya, p_idempotency_key: "k", p_starts_on: today, p_planned_return_on: null, p_fee_method: "cash", p_fee_upi_reference: null, p_approved_by: owner }]);
    await assert.rejects(startHold(ids.riya, {}, { gymId: null }, client), (error) => error.status === 403);
});

test("another gym's hold can't be resumed: it is not found before anything changes", async () => {
    const db = withHolds(fakeCheckinDb(), [riyaHold]);
    await assert.rejects(resumeHold(ids.riya, riyaHold.id, { gymId: gymB, userId: owner }, db), (error) => error instanceof HoldError && error.status === 404);
    await assert.rejects(resumeHold(ids.dev, riyaHold.id, { gymId: gymA, userId: owner }, db), (error) => error.status === 404, "nor through another member");
    assert.equal(db.rpcs.length, 0);
});

test("database refusals become clear messages with a short code", () => {
    const refused = (details, message) => holdDatabaseError({ code: "P0001", details, message });
    assert.deepEqual([refused("no_holds_left", "Both holds already used.").status, refused("no_holds_left", "x").reason], [409, "no_holds_left"]);
    assert.equal(refused("holds_not_allowed", "Monthly plans can't be put on hold.").message, "Monthly plans can't be put on hold.");
    assert.equal(refused("return_too_soon", "x").reason, "return_too_soon");
    assert.equal(holdDatabaseError({ code: "42P01" }).status, 503);
    assert.match(holdDatabaseError({ code: "42P01" }).message, /021_add_plan_holds/);
    assert.equal(holdDatabaseError({ code: "P0002", message: "Hold not found." }).status, 404);
    assert.equal(holdDatabaseError({ code: "22023" }).reason, "key_reused");
});

test("renewing during a hold is refused with 'Resume the plan first'", async () => {
    const client = { rpc: () => Promise.resolve({ data: null, error: { code: "P0001", details: "on_hold", message: "This member's plan is on hold. Resume the plan first." } }) };
    await assert.rejects(renewMember(ids.riya, { idempotency_key: "k", plan_id: "p" }, { gymId: gymA }, client),
        (error) => error.status === 409 && error.reason === "on_hold" && /Resume the plan first/.test(error.message));
});

function fakeResponse() {
    return { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
}

test("API: a new hold is 201, a repeated key 200; the context comes from the sign-in", async () => {
    const seen = [];
    let replayed = false;
    const handlers = createHoldHandlers({
        startHold: async (memberId, payload, context) => { seen.push([memberId, payload, context]); const result = { replayed, hold: { id: "h" } }; replayed = true; return result; },
        resumeHold: async (memberId, holdId, context) => ({ replayed: false, hold: { id: holdId, member_id: memberId, context } }),
        cancelHold: async () => ({ replayed: false, hold: { id: "h" } }),
        listMemberHolds: async () => ({ holds: [] })
    });
    const request = { params: { id: ids.riya, holdId: "h" }, holdPayload: { idempotency_key: "k", starts_on: today }, gymId: gymA, authUser: { id: owner }, body: { gym_id: gymB } };
    for (const expected of [201, 200]) {
        const response = fakeResponse();
        await new Promise((resolve, reject) => { handlers.postHold(request, Object.assign(response, { json(payload) { this.body = payload; resolve(); return this; } }), reject); });
        assert.equal(response.statusCode, expected);
        assert.equal(response.headers["Cache-Control"], "no-store");
    }
    assert.deepEqual(seen[0][2], { gymId: gymA, userId: owner }, "the gym in the body is ignored");
    const resumed = fakeResponse();
    await new Promise((resolve, reject) => { handlers.postResume(request, Object.assign(resumed, { json(payload) { this.body = payload; resolve(); return this; } }), reject); });
    assert.equal(resumed.body.data.hold.context.reason, "resumed");
});

test("validation: the hold request is strict, and holds settings and plan limits stay in range", () => {
    const key = "00000000-0000-4000-8000-000000000123";
    assert.equal(run(validateHoldPayload, { idempotency_key: key, starts_on: today, planned_return_on: null }).passed, true);
    assert.equal(run(validateHoldPayload, { idempotency_key: key, starts_on: today, planned_return_on: "2026-12-01", method: "upi", upi_reference: "123456789012" }).passed, true);
    for (const body of [
        { idempotency_key: key, starts_on: "2026-02-30" },
        { idempotency_key: "nope", starts_on: today },
        { idempotency_key: key, starts_on: today, gym_id: gymB },
        { idempotency_key: key, starts_on: today, method: "upi", upi_reference: "123" }
    ]) assert.equal(run(validateHoldPayload, body).passed, false, JSON.stringify(body));

    assert.equal(run(validateRenewalSettings, { min_hold_days: 0, hold_fee_enabled: false }).passed, true, "0 means no minimum");
    assert.equal(run(validateRenewalSettings, { hold_fee_enabled: true, hold_fee_amount: 200 }).passed, true);
    assert.equal(run(validateRenewalSettings, { hold_fee_enabled: true, hold_fee_amount: 0 }).passed, false, "a fee that is on must be above 0");
    assert.equal(run(validateRenewalSettings, { min_hold_days: 400 }).passed, false);

    const planCheck = (body) => run(validatePlanPayload("update"), body).passed;
    assert.equal(planCheck({ max_hold_days: 20, max_holds: 1 }), true);
    assert.equal(planCheck({ max_hold_days: null, max_holds: null }), true, "empty uses the default");
    assert.equal(planCheck({ max_hold_days: 0 }), false);
    assert.equal(planCheck({ max_holds: 13 }), false);
});

// ---------- Messages and money ----------

test("the welcome back message names the new end date and grace, in the gym's language", () => {
    const fields = { name: "Riya Shah", plan: "Quarterly", endDate: "07 Dec 2026", graceDate: "10 Dec 2026", gymName: "Power Gym", gymPhone: "+91 98230 12345" };
    const en = buildHoldReturnMessage(fields);
    assert.match(en, /^Hi Riya, welcome back to Power Gym!/);
    assert.match(en, /now ends on 07 Dec 2026 \(grace till 10 Dec 2026\)/);
    assert.match(en, /\+91 98230 12345/);
    assert.match(buildHoldReturnMessage({ ...fields, language: "hi" }), /07 Dec 2026/);
    assert.match(buildHoldReturnMessage({ ...fields, language: "mr" }), /07 Dec 2026/);
    assert.doesNotMatch(buildHoldReturnMessage({ ...fields, graceDate: "" }), /grace/);
});

test("the welcome back message is logged as its own type", () => {
    assert.equal(run(validateMessagePayload, { reminder_type: "hold_return", language: "en", body: "Hi" }).passed, true);
});

test("a hold fee is money collected, but it never pays off the plan's fee", () => {
    const billing = memberBilling([{ status: "assigned", total_fees: 4000 }], [{ amount: 1000, kind: "plan" }, { amount: 200, kind: "hold_fee" }, { amount: 500 }]);
    assert.deepEqual(billing, { billed: 4000, paid: 1500, outstanding: 2500 });
});
