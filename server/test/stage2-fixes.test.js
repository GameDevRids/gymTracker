// The bug fixes from the live-app review: names that are empty or an email address, the Expiring
// reminder count, inactivity counted from the join date, the renewal numbers (one definition, checked
// against the database), and the retired "Suspended" status.
import test from "node:test";
import assert from "node:assert/strict";
import { NO_NAME, displayName, inactiveDaysFor, messageName, nameIsMissing } from "../../assets/js/utils.js";
import { guessColumns, planImport, readImportRows } from "../../assets/js/modules/memberImport.js";
import { memberStatusFor } from "../../assets/js/memberStatus.js";
import { inactiveCount, renewalStats } from "../services/memberStatusService.js";
import { createMigratedDatabase } from "./helpers/database.js";

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { memberFromApiRow, memberToApiPayload } = await import("../../assets/js/state.js");
const { renderExpiring } = await import("../../assets/js/modules/expiring.js");

// ---------- Names ----------

test("an empty name or an email address is never shown as the name", () => {
    for (const value of ["", "   ", null, "kenneth_young511@mailinator.com", " a@b.co "]) {
        assert.equal(nameIsMissing(value), true, String(value));
        assert.equal(displayName(value), NO_NAME);
        assert.equal(messageName(value), "", "messages fall back to 'there', never the email");
    }
    assert.equal(displayName("  Riya   Shah "), "Riya Shah");
    assert.equal(nameIsMissing("Riya Shah"), false);
});

test("a member saved with an email name is flagged, and saving never writes the label back", () => {
    const member = memberFromApiRow({ id: "m1", full_name: "kenneth_young511@mailinator.com", phone: "9876543210" });
    assert.equal(member.name, NO_NAME);
    assert.equal(member.nameMissing, true);
    assert.equal(memberToApiPayload(member).full_name, "kenneth_young511@mailinator.com", "unchanged until someone types a name");
    assert.equal(memberToApiPayload({ ...member, name: "Kenneth Young" }).full_name, "Kenneth Young");
    assert.equal(memberFromApiRow({ id: "m2", full_name: "Riya Shah" }).nameMissing, false);
});

test("import: an email column is never matched as the name, and an email in the name column is refused", () => {
    const text = (...values) => values.map((value) => ({ text: value }));
    assert.equal(guessColumns(text("Email", "Phone")).name, -1);
    const header = text("Name", "Email", "Phone");
    const columns = guessColumns(header);
    assert.equal(columns.name, 0);
    const rows = readImportRows([header, text("kenneth_young511@mailinator.com", "k@x.com", "9876543210")], 0, columns);
    const plan = planImport(rows);
    assert.equal(plan.payload.rows.length, 0);
    assert.match(JSON.stringify(plan), /email/i);
});

// ---------- Expiring soon: the reminder count ----------

test("Expiring soon: two members both reminded is '0 to remind, 2 reminded'", () => {
    const row = (id, member) => ({ id, plan_name: "Monthly", end_date: "2026-11-14", days_left: 2, member_status: "expiring", remindable: true, member });
    const rows = [row("m1", { id: "a", full_name: "Riya Shah", phone: "9876543210", whatsapp_opt_in: true }), row("m2", { id: "b", full_name: "Dev Rao", phone: "9876543211", whatsapp_opt_in: true })];
    // Keys come from reminderKey(); read the real ones by reminding nobody, then mark everybody.
    const none = renderExpiring(rows, "ready", "Hi {name}", new Set());
    assert.match(none, /data-to-remind-count>2</);
    assert.match(none, /data-reminded-count>0</);
    const keys = [...none.matchAll(/data-remind-key="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(keys.length, 2);
    const done = renderExpiring(rows, "ready", "Hi {name}", new Set(keys));
    assert.match(done, /data-to-remind-count>0</);
    assert.match(done, /data-reminded-count>2</);
});

// ---------- Inactivity ----------

test("days inactive count from the later of joining and the last visit", () => {
    const today = "2026-11-17";
    assert.equal(inactiveDaysFor({ joinedAt: "2026-11-10" }, undefined, today), 7, "joined a week ago, never visited: 7, not 30+");
    assert.equal(inactiveDaysFor({ joinedAt: "2026-09-01" }, "2026-11-15", today), 2);
    assert.equal(inactiveDaysFor({ joinedAt: "2026-11-16" }, "2026-10-01", today), 1, "a re-joined member counts from the join");
    assert.equal(inactiveDaysFor({ joinedAt: "" }, undefined, today), null);
});

// ---------- Renewal numbers and inactive members, checked against the database ----------

test("Analytics numbers match the database: renewal rate, renewed, inactive, active", async () => {
    const db = await createMigratedDatabase();
    const today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).rows[0].d;
    const shift = (days) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
    const owner = "00000000-0000-4000-8000-00000000000a";
    const gym = "00000000-0000-4000-8000-0000000000a1";
    await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${owner}', 'o@x.test'); INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gym}', 'A', '${owner}');`);
    const plan = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 1000) RETURNING id", [gym])).rows[0].id;
    let phone = 0;
    const member = async (name, joinedDaysAgo) => (await db.query("INSERT INTO public.members (gym_id, member_code, full_name, phone, created_at) VALUES ($1, $5, $2, $3, now() - make_interval(days => $4)) RETURNING id",
        [gym, name, `98000000${String(++phone).padStart(2, "0")}`, joinedDaysAgo, `GP-T${phone}`])).rows[0].id;
    const membership = (memberId, start, end, createdDaysAgo = 0) => db.query("INSERT INTO public.member_memberships (gym_id, member_id, plan_id, plan_name, duration_days, price, total_fees, start_date, end_date, created_at) VALUES ($1, $2, $3, 'Monthly', 30, 1000, 1000, $4, $5, now() - make_interval(days => $6))",
        [gym, memberId, plan, shift(start), shift(end), createdDaysAgo]);
    const visit = (memberId, daysAgo) => db.query("INSERT INTO public.attendance (gym_id, member_id, method, membership_status_at_check_in, checked_in_at) VALUES ($1, $2, 'manual', 'active', now() - make_interval(days => $3))", [gym, memberId, daysAgo]);

    const regular = await member("Regular", 40); await membership(regular, -10, 19); await visit(regular, 3);
    const newcomer = await member("Newcomer", 5); await membership(newcomer, -5, 24);
    const quiet = await member("Quiet", 60); await membership(quiet, -20, 9); await visit(quiet, 20);
    const renewed = await member("Renewed", 90); await membership(renewed, -40, -10, 40); await membership(renewed, -9, 20, 9);
    const lapsed = await member("Lapsed", 90); await membership(lapsed, -35, -5, 35);
    const early = await member("Early", 90); await membership(early, -20, 9, 20); await membership(early, 10, 39, 1);

    const sql = (await db.query("SELECT public.gympulse_gym_summary($1) AS s", [gym])).rows[0].s;
    // The rows the server works with: each member's status and plan history, as memberStatuses() builds them.
    const members = (await db.query("SELECT id, created_at FROM public.members WHERE gym_id = $1", [gym])).rows;
    const plans = (await db.query("SELECT id, member_id, start_date::text, end_date::text, status, grace_days, created_at FROM public.member_memberships WHERE gym_id = $1", [gym])).rows;
    const rows = members.map((row) => {
        const history = plans.filter((item) => item.member_id === row.id);
        return { member: { id: row.id, created_at: row.created_at.toISOString() }, state: memberStatusFor(history, today, { lapsedListDays: 60, defaultGraceDays: 3 }), history };
    });
    const visitors = new Set((await db.query("SELECT DISTINCT member_id FROM public.attendance WHERE gym_id = $1 AND check_in_date > $2::date - 14", [gym, today])).rows.map((row) => row.member_id));

    // Plans that ended in the last 30 days: Renewed's (has a newer plan) and Lapsed's (does not).
    // Early renewed a plan that is still running, so it is not due yet.
    assert.deepEqual(renewalStats(rows, today), { due: 2, renewed: 1 });
    assert.equal(sql.due_last_30_days, 2, "the database agrees on who is due");
    assert.equal(sql.renewed_last_30_days, 1);
    // The old "Renewals this month" counted Renewed and Early (two new plans this month) – the mismatch.
    assert.equal(sql.renewals_this_month, 2);

    // Inactive: Quiet (last visit 20 days ago), Renewed and Early (running plans, never visited, joined
    // 90 days ago). Not Newcomer (joined 5 days ago) and not Regular (visited 3 days ago).
    assert.equal(inactiveCount(rows, visitors, today), 3);
    assert.equal(sql.inactive_members, 4, "the database's own figure also counted the newcomer");

    const statuses = rows.map((row) => row.state.status).sort();
    assert.equal(statuses.filter((status) => status === "active" || status === "expiring").length, sql.active_members, "active members agree");
    assert.equal(sql.total_members, 6);
});

// ---------- "Suspended" ----------

test("the old Suspended flag is kept on the member but is never a status", () => {
    const member = memberFromApiRow({ id: "m1", full_name: "Charles", status: "suspended", member_status: "active" });
    assert.equal(member.status, "suspended", "the stored flag is untouched");
    assert.equal(member.memberStatus, "active", "the status is the real one");
    assert.equal(memberToApiPayload(member).status, "suspended", "saving keeps it");
});
