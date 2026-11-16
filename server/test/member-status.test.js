// Member status (assets/js/memberStatus.js), the lists built from it (Expiring soon, Lapsed, Old),
// the Overview counts, the Lapsed page's message buttons, renewal settings and plan grace checks,
// and that the shared start-date rule agrees with the renew function in the database (020).
import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { checkInDecision, graceUntil, memberStatusFor, remindable } from "../../assets/js/memberStatus.js";
import { renewalPlan } from "../../assets/js/renewal.js";
import { buildLapsedMessage } from "../../assets/js/lapsedMessage.js";
import { countStatuses, listExpiring, listLapsed, memberStatuses } from "../services/memberStatusService.js";
import { validateRenewalSettings } from "../middleware/validateRenewal.js";
import { validatePlanPayload } from "../middleware/validatePlan.js";
import { fakeStatusDb, otherGym, statusGym } from "./helpers/fakeStatusDb.js";
import { installPhotoDom } from "./helpers/fakeDom.js";
import { createMigratedDatabase } from "./helpers/database.js";

const today = "2026-11-17";
const plan = (start, end, extra = {}) => ({ id: `p-${start}-${end}`, status: "assigned", start_date: start, end_date: end, grace_days: 3, created_at: `${start}T05:00:00Z`, ...extra });
const status = (plans, options) => memberStatusFor(plans, today, options);

// ---------- The rule ----------

test("active: a plan covers today with more than 7 days left", () => {
    const state = status([plan("2026-11-01", "2026-11-25")]);
    assert.equal(state.status, "active");
    assert.equal(state.daysLeft, 8);
});

test("expiring: 7 days or fewer left, including the last day", () => {
    assert.equal(status([plan("2026-11-01", "2026-11-24")]).status, "expiring");
    assert.equal(status([plan("2026-11-01", "2026-11-24")]).daysLeft, 7);
    assert.equal(status([plan("2026-10-19", today)]).status, "expiring");
    assert.equal(status([plan("2026-10-19", today)]).daysLeft, 0);
});

test("a booked future plan keeps the member active, never expiring or lapsed", () => {
    assert.equal(status([plan("2026-10-21", "2026-11-19"), plan("2026-11-20", "2026-12-19")]).status, "active");
    const upcoming = status([plan("2026-06-01", "2026-06-30"), plan("2026-11-25", "2026-12-24")]);
    assert.equal(upcoming.status, "upcoming", "nothing covers today, a plan is booked");
    assert.equal(upcoming.nextStart, "2026-11-25");
});

test("in grace: ended 1 to grace_days days ago, with the days left and the last grace day", () => {
    const first = status([plan("2026-10-17", "2026-11-16")]);
    assert.deepEqual([first.status, first.graceDaysLeft, first.graceUntil, first.endedOn], ["in_grace", 2, "2026-11-19", "2026-11-16"]);
    const last = status([plan("2026-10-15", "2026-11-14")]);
    assert.deepEqual([last.status, last.graceDaysLeft], ["in_grace", 0]);
});

test("lapsed: grace over, ended up to lapsed_list_days ago; then old", () => {
    assert.equal(status([plan("2026-10-14", "2026-11-13")]).status, "lapsed", "the day after grace");
    assert.equal(status([plan("2026-08-19", "2026-09-18")]).status, "lapsed", "60 days after the end");
    assert.equal(status([plan("2026-08-18", "2026-09-17")]).status, "old", "61 days after the end");
    assert.equal(status([plan("2026-08-18", "2026-09-17")], { lapsedListDays: 90 }).status, "lapsed", "the gym's own period");
});

test("each membership's own grace decides; older plans without one use the gym default", () => {
    assert.equal(status([plan("2026-10-10", "2026-11-10", { grace_days: 10 })]).status, "in_grace");
    assert.equal(status([plan("2026-10-10", "2026-11-16", { grace_days: 0 })]).status, "lapsed", "0 grace: lapsed the next day");
    assert.equal(status([plan("2026-10-10", "2026-11-12", { grace_days: undefined })], { defaultGraceDays: 5 }).status, "in_grace");
    assert.equal(graceUntil({ end_date: "2026-11-30", grace_days: 4 }), "2026-12-04");
});

test("no plan, and cancelled plans ignored", () => {
    assert.equal(status([]).status, "none");
    assert.equal(status([plan("2026-11-01", "2026-12-31", { status: "cancelled" })]).status, "none");
    assert.equal(status([plan("2026-11-01", "2026-12-31", { status: "cancelled" }), plan("2026-10-01", "2026-11-10")]).status, "lapsed");
});

test("reminders are offered from 3 days before the end and all through grace", () => {
    assert.equal(remindable(status([plan("2026-11-01", "2026-11-20")])), true);
    assert.equal(remindable(status([plan("2026-11-01", "2026-11-21")])), false, "4 days left");
    assert.equal(remindable(status([plan("2026-10-17", "2026-11-16")])), true, "in grace");
    assert.equal(remindable(status([plan("2026-10-01", "2026-10-20")])), false, "lapsed: the Lapsed list has its own message");
});

test("check-in follows the status", () => {
    assert.deepEqual(["active", "expiring", "upcoming", "in_grace", "lapsed", "old", "none"].map((s) => checkInDecision(s).allowed), [true, true, true, true, false, false, false]);
});

// ---------- The lists and counts (server) ----------

const members = [
    { id: "riya", full_name: "Riya Shah", phone: "9876543210", whatsapp_opt_in: true },
    { id: "dev", full_name: "Dev Rao", phone: "9876543211", whatsapp_opt_in: false },
    { id: "aisha", full_name: "Aisha Khan", phone: "9876543212", whatsapp_opt_in: true },
    { id: "kabir", full_name: "Kabir Mehta", phone: "9876543213", whatsapp_opt_in: true },
    { id: "meera", full_name: "Meera Iyer", phone: "9876543214", whatsapp_opt_in: true },
    { id: "neil", full_name: "Neil Das", phone: "9876543215" },
    { id: "gone", full_name: "Archived Person", phone: "9876543216", archived_at: "2026-11-01T00:00:00Z" },
    { id: "zoya", full_name: "Zoya Khan", phone: "9876543217", whatsapp_opt_in: true }
];
const memberships = [
    plan("2026-10-21", "2026-11-19", { member_id: "riya", plan_name: "Monthly" }),           // expiring, 2 days
    plan("2026-10-17", "2026-11-16", { member_id: "dev", plan_name: "Monthly" }),            // in grace
    plan("2026-10-01", "2026-10-30", { member_id: "aisha", plan_name: "Monthly" }),          // lapsed
    plan("2026-06-01", "2026-06-30", { member_id: "kabir", plan_name: "Monthly" }),          // old
    plan("2026-10-21", "2026-11-19", { member_id: "meera", plan_name: "Monthly" }),          // renewed:
    plan("2026-11-20", "2026-12-19", { member_id: "meera", plan_name: "Monthly" }),          //   active
    plan("2026-10-01", "2026-10-30", { member_id: "gone", plan_name: "Monthly" }),           // archived: never listed
    plan("2026-10-21", "2026-11-23", { member_id: "zoya", plan_name: "Monthly" })            // expiring, 6 days
];
const db = () => fakeStatusDb({ members, memberships, messages: [{ member_id: "aisha", reminder_type: "lapsed", created_at: "2026-11-10T04:00:00Z" }] });

test("Expiring soon lists expiring and in-grace members only, soonest end first, with the reminder flag", async () => {
    const rows = await listExpiring(statusGym, db(), today);
    assert.deepEqual(rows.map((row) => [row.member.id, row.member_status, row.remindable]), [["dev", "in_grace", true], ["riya", "expiring", true], ["zoya", "expiring", false]]);
    assert.equal(rows[0].grace_until, "2026-11-19");
    assert.equal(rows[0].grace_days_left, 2);
});

test("a renewed member (a later plan booked) is on no list", async () => {
    const all = await memberStatuses(statusGym, db(), today);
    assert.equal(all.find((row) => row.member.id === "meera").state.status, "active");
    for (const list of [await listExpiring(statusGym, db(), today), await listLapsed(statusGym, "lapsed", db(), today), await listLapsed(statusGym, "old", db(), today)]) {
        assert.ok(!list.some((row) => row.member.id === "meera"));
    }
});

test("Lapsed and Old members lists, most recently ended first, with when a message was last sent", async () => {
    const lapsed = await listLapsed(statusGym, "lapsed", db(), today);
    assert.deepEqual(lapsed.map((row) => [row.member.id, row.ended_on, row.days_since_end]), [["aisha", "2026-10-30", 18]]);
    assert.equal(lapsed[0].renewal_message_sent_at, "2026-11-10T04:00:00Z");
    const old = await listLapsed(statusGym, "old", db(), today);
    assert.deepEqual(old.map((row) => row.member.id), ["kabir"]);
});

test("Overview counts come from the same rule, and archived members are left out", async () => {
    const counts = countStatuses(await memberStatuses(statusGym, db(), today));
    assert.deepEqual(counts, { active: 1, expiring: 2, upcoming: 0, in_grace: 1, lapsed: 1, old: 1, none: 1 });
});

test("every query stays inside the gym", async () => {
    const client = db();
    await listLapsed(statusGym, "lapsed", client, today);
    for (const query of client.queries) {
        const scoped = query.table === "gyms" ? query.filters.some(([, column, value]) => column === "id" && value === statusGym)
            : query.filters.some(([, column, value]) => column === "gym_id" && value === statusGym);
        assert.ok(scoped, `${query.table} is scoped to the gym`);
    }
    assert.deepEqual(await listExpiring(otherGym, client, today), [], "another gym sees none of these members");
});

// ---------- The Lapsed page: message buttons only with consent, and every message logged ----------

let dom;
let lapsedPage;
let appState;
const requests = [];
before(async () => {
    const boot = installPhotoDom();
    lapsedPage = await import("../../assets/js/modules/lapsed.js");
    ({ state: appState } = await import("../../assets/js/state.js"));
    boot.restore();
});
beforeEach(() => {
    dom = installPhotoDom();
    requests.length = 0;
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
        const rows = [
            { plan_name: "Monthly", ended_on: "2026-10-30", days_since_end: 18, member_status: "lapsed", member: { id: "00000000-0000-4000-8000-000000000001", full_name: "Aisha Khan", phone: "9876543212", whatsapp_opt_in: true } },
            { plan_name: "Monthly", ended_on: "2026-10-25", days_since_end: 23, member_status: "lapsed", member: { id: "00000000-0000-4000-8000-000000000002", full_name: "Dev Rao", phone: "9876543211", whatsapp_opt_in: false } }
        ];
        const data = String(url).includes("/whatsapp-messages") ? { id: "w1" } : rows;
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ status: "success", data }) };
    };
});
afterEach(() => dom.restore());

test("only members who agreed get a renewal message button; the message has the end date and the gym's number", async () => {
    Object.assign(appState.gym, { name: "Power Gym", phone: "9822001122" });
    await lapsedPage.loadLapsed("lapsed");
    const html = lapsedPage.renderLapsedPage();
    const links = [...html.matchAll(/href="https:\/\/wa\.me\/91(\d+)\?text=([^"]+)"/g)];
    assert.deepEqual(links.map((match) => match[1]), ["9876543212"]);
    const text = decodeURIComponent(links[0][2]);
    assert.match(text, /Hi Aisha/);
    assert.match(text, /ended on 30 Oct 2026/);
    assert.match(text, /98220 01122|9822001122/);
    assert.equal((html.match(/No WhatsApp consent/g) || []).length, 1);
    assert.equal((html.match(/data-action="renew-member"/g) || []).length, 2, "Renew for both");
});

test("sending a renewal message logs it in the WhatsApp history as 'lapsed'", async () => {
    await lapsedPage.loadLapsed("lapsed");
    const target = { closest: (selector) => (selector === "[data-lapsed-message]" ? { dataset: { lapsedMessage: "00000000-0000-4000-8000-000000000001" } } : null) };
    assert.equal(lapsedPage.handleLapsedClick(target, () => {}), true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const logged = requests.find((request) => request.url.includes("/whatsapp-messages"));
    assert.equal(logged.method, "POST");
    assert.equal(logged.body.reminder_type, "lapsed");
    assert.match(logged.body.body, /Aisha/);
});

test("the lapsed message reads well in each language, and leaves out a missing phone", () => {
    const en = buildLapsedMessage({ language: "en", name: "Riya Shah", plan: "Monthly", endedOn: "30 Oct 2026", gymName: "Power Gym", gymPhone: "98220 01122" });
    assert.match(en, /^Hi Riya, we miss you at Power Gym!/);
    assert.match(en, /98220 01122/);
    assert.doesNotMatch(buildLapsedMessage({ language: "en", name: "Riya", plan: "Monthly", endedOn: "x", gymName: "G" }), /Call/);
    assert.match(buildLapsedMessage({ language: "hi", name: "Riya", plan: "Monthly", endedOn: "30 Oct 2026", gymName: "G" }), /नमस्ते Riya/);
    assert.match(buildLapsedMessage({ language: "mr", name: "Riya", plan: "Monthly", endedOn: "30 Oct 2026", gymName: "G" }), /नमस्कार Riya/);
});

// ---------- Settings checks ----------

function run(middleware, body) {
    const request = { body };
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
    let passed = false;
    middleware(request, response, () => { passed = true; });
    return { passed, request, response };
}

test("renewal settings: grace 0–60, percent up to 100, lapsed list 7–365, nothing else", () => {
    assert.equal(run(validateRenewalSettings, { expiry_grace_days: 3, welcome_back_discount_type: "percent", welcome_back_discount_value: 10, lapsed_list_days: 60 }).passed, true);
    assert.equal(run(validateRenewalSettings, { welcome_back_discount_type: "amount", welcome_back_discount_value: 500 }).passed, true);
    for (const body of [{ expiry_grace_days: 61 }, { expiry_grace_days: 1.5 }, { lapsed_list_days: 3 }, { welcome_back_discount_type: "percent", welcome_back_discount_value: 120 }, { welcome_back_discount_type: "free" }, { gym_id: "x" }, {}]) {
        assert.equal(run(validateRenewalSettings, body).passed, false, JSON.stringify(body));
    }
});

test("a plan's grace: 0–60 days, or empty for the gym default", () => {
    const check = (body) => run(validatePlanPayload("update"), body);
    assert.equal(check({ grace_days: 4 }).passed, true);
    assert.equal(check({ grace_days: null }).passed, true, "empty = use the gym default");
    assert.equal(check({ grace_days: 0 }).passed, true);
    for (const value of [61, -1, 2.5, "3"]) assert.equal(check({ grace_days: value }).passed, false, String(value));
});

// ---------- The shared start-date rule agrees with the database (migration 020) ----------

let pg;
const owner = "00000000-0000-4000-8000-00000000000a";
const gym = "00000000-0000-4000-8000-0000000000c1";
let pgToday;
let monthly;
let phones = 0;
let keys = 0;
const shift = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

before(async () => {
    pg = await createMigratedDatabase();
    await pg.exec(`INSERT INTO auth.users (id, email) VALUES ('${owner}', 'o@example.test');
        INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gym}', 'Gym C', '${owner}');`);
    pgToday = (await pg.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).rows[0].d;
    monthly = (await pg.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 1500) RETURNING id", [gym])).rows[0].id;
});
after(async () => pg?.close?.());

async function pgMember(startOffset, endOffset, withPlan = true) {
    phones += 1;
    const phone = `98760${String(phones).padStart(5, "0")}`;
    await pg.query("SELECT public.gympulse_import_members($1, $2::jsonb)", [gym, JSON.stringify({ rows: [{ row: 2, full_name: `P ${phones}`, phone, notes: null, plan: withPlan ? { id: monthly } : null, start_date: withPlan ? shift(pgToday, startOffset) : null, end_date: withPlan ? shift(pgToday, endOffset) : null, amount_paid: null }] })]);
    return (await pg.query("SELECT id FROM public.members WHERE gym_id = $1 AND phone = $2", [gym, phone])).rows[0].id;
}
const history = async (memberId) => (await pg.query("SELECT id, status, start_date::text AS start_date, end_date::text AS end_date, grace_days, created_at::text AS created_at FROM public.member_memberships WHERE member_id = $1", [memberId])).rows;
const pgRenew = (memberId) => pg.query("SELECT public.gympulse_renew_member($1::uuid, $2::uuid, $3::uuid, $4::uuid, null::date, null::date, null::numeric, null::text, 0::numeric, 'cash', null, $5::uuid) AS r",
    [gym, memberId, `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`, monthly, owner]).then((x) => x.rows[0].r);

test("the shared start-date rule gives the same start as the database, before and after the end", async () => {
    for (const [label, start, end, withPlan] of [["active", -10, 19, true], ["expiring", -26, 3, true], ["ends today", -29, 0, true], ["in grace", -31, -2, true], ["lapsed", -60, -30, true], ["old", -200, -170, true], ["no plan", 0, 0, false]]) {
        const id = await pgMember(start, end, withPlan);
        const expected = renewalPlan(await history(id), pgToday);
        const result = await pgRenew(id);
        assert.equal(String(result.membership.start_date).slice(0, 10), expected.startDate, label);
        assert.equal(result.renewal.start_choice, expected.choice, label);
    }
});

test("after renewing, the member is active (off Expiring soon and the Lapsed list)", async () => {
    for (const [label, start, end] of [["expiring", -26, 3], ["in grace", -31, -2], ["lapsed", -60, -30]]) {
        const id = await pgMember(start, end);
        assert.notEqual(memberStatusFor(await history(id), pgToday).status, "active", `${label} before`);
        await pgRenew(id);
        assert.equal(memberStatusFor(await history(id), pgToday).status, "active", `${label} after`);
    }
});
