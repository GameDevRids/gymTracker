// Runs migration 020 in real Postgres (PGlite) on a database at 019 that already holds gyms and
// memberships: grace defaults and backfill, grace copied per membership, the new renewal function
// (start dates, owner date, discounts, rollback, one renewal per key, gym isolation).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMigratedDatabase } from "./helpers/database.js";

const draft = readFileSync(new URL("../migrations/020_add_grace_and_lapsed_members.sql", import.meta.url), "utf8");
// The live project is at 019 with data in it; 020 is then applied on top, as in the SQL Editor.
const db = await createMigratedDatabase({ upTo: "019_add_one_tap_renewal.sql" });
const owner = "00000000-0000-4000-8000-00000000000a";
const gymA = "00000000-0000-4000-8000-0000000000a1";
const gymB = "00000000-0000-4000-8000-0000000000b1";
const today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).rows[0].d;
const shift = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const day = (v) => String(v).slice(0, 10);
const results = [];
const check = (label, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  <- ${detail}` : ""}`);
const fails = async (promise, pattern) => { try { await promise; return "no error"; } catch (error) { return pattern.test(error.message) ? "ok" : error.message; } };
let phones = 0;
let keys = 0;
const key = () => `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`;
const member = async (gym, planId, startOffset, endOffset) => {
    phones += 1;
    const phone = `98765${String(phones).padStart(5, "0")}`;
    await db.query("SELECT public.gympulse_import_members($1, $2::jsonb)", [gym, JSON.stringify({ rows: [{ row: 2, full_name: `M ${phones}`, phone, notes: null, plan: planId ? { id: planId } : null, start_date: planId ? shift(today, startOffset) : null, end_date: planId ? shift(today, endOffset) : null, amount_paid: null }] })]);
    return (await db.query("SELECT id FROM public.members WHERE gym_id = $1 AND phone = $2", [gym, phone])).rows[0].id;
};
const grace = async (memberId) => (await db.query("SELECT grace_days FROM public.member_memberships WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1", [memberId])).rows[0].grace_days;

// ---- the live project today: gym A has grace 0 (the old default), gym B chose 5 ----
await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${owner}', 'o@example.test');
    INSERT INTO public.gyms (id, name, owner_user_id) VALUES ('${gymA}', 'A', '${owner}'), ('${gymB}', 'B', '${owner}');
    UPDATE public.gyms SET expiry_grace_days = 5 WHERE id = '${gymB}';`);
const planA = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 1500) RETURNING id", [gymA])).rows[0].id;
const planB = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price) VALUES ($1, 'Monthly', 30, 1500) RETURNING id", [gymB])).rows[0].id;
const oldA = await member(gymA, planA, -40, -10);
const oldB = await member(gymB, planB, -40, -10);

await db.exec(draft);
const gymGrace = async (gym) => (await db.query("SELECT expiry_grace_days FROM public.gyms WHERE id = $1", [gym])).rows[0].expiry_grace_days;
check("gym at 0 becomes 3", (await gymGrace(gymA)) === 3);
check("gym that chose 5 keeps 5", (await gymGrace(gymB)) === 5);
check("existing memberships get their gym's default", (await grace(oldA)) === 3 && (await grace(oldB)) === 5, `${await grace(oldA)} ${await grace(oldB)}`);
check("new gyms default to 3", (await db.query("SELECT column_default FROM information_schema.columns WHERE table_name='gyms' AND column_name='expiry_grace_days'")).rows[0].column_default === "3");

// ---- run again after the owner deliberately sets 0 ----
await db.query("UPDATE public.gyms SET expiry_grace_days = 0 WHERE id = $1", [gymA]);
await db.exec(draft);
check("running again does not undo an owner's 0", (await gymGrace(gymA)) === 0);
check("running again does not touch existing memberships", (await grace(oldA)) === 3);
await db.query("UPDATE public.gyms SET expiry_grace_days = 3 WHERE id = $1", [gymA]);

// ---- grace copied on creation; later rule changes do not reach existing memberships ----
const quarterly = (await db.query("INSERT INTO public.membership_plans (gym_id, name, duration_days, price, grace_days) VALUES ($1, 'Quarterly', 90, 4000, 4) RETURNING id", [gymA])).rows[0].id;
const usesGym = await member(gymA, planA, -5, 24);
const usesPlan = await member(gymA, quarterly, -5, 84);
check("a plan without grace uses the gym default", (await grace(usesGym)) === 3);
check("a plan's own grace wins", (await grace(usesPlan)) === 4);
await db.query("UPDATE public.membership_plans SET grace_days = 9 WHERE id = $1", [quarterly]);
await db.query("UPDATE public.gyms SET expiry_grace_days = 6 WHERE id = $1", [gymA]);
check("changing the rules later leaves existing memberships alone", (await grace(usesGym)) === 3 && (await grace(usesPlan)) === 4);
await db.query("UPDATE public.gyms SET expiry_grace_days = 3 WHERE id = $1", [gymA]);
check("a plan's grace outside 0-60 is refused", (await fails(db.query("UPDATE public.membership_plans SET grace_days = 61 WHERE id = $1", [quarterly]), /grace_days_range/)) === "ok");
check("lapsed list days outside 7-365 refused", (await fails(db.query("UPDATE public.gyms SET lapsed_list_days = 3 WHERE id = $1", [gymA]), /lapsed_list_days_range/)) === "ok");
check("percent over 100 refused", (await fails(db.query("UPDATE public.gyms SET welcome_back_discount_type = 'percent', welcome_back_discount_value = 120 WHERE id = $1", [gymA]), /welcome_back_discount_valid/)) === "ok");

// ---- the new renew function ----
const renew = (gym, memberId, a = {}) => db.query("SELECT public.gympulse_renew_member($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, $7::numeric, $8::text, $9::numeric, $10::text, $11::text, $12::uuid) AS r",
    [gym, memberId, a.key || key(), a.plan || planA, a.start || null, a.expected || null, a.fee ?? null, a.reason || null, a.paid ?? null, a.method || "cash", a.utr || null, owner]).then((x) => x.rows[0].r);

const active = await member(gymA, planA, -26, 3);
let r = await renew(gymA, active, { paid: 1500 });
check("before the end: starts the day after it ends", day(r.membership.start_date) === shift(today, 4) && r.renewal.start_choice === "after_current");
check("result has grace_days and grace_until", r.membership.grace_days === 3 && day(r.membership.grace_until) === shift(today, 33 + 3), JSON.stringify([r.membership.grace_days, r.membership.grace_until]));

const inGrace = await member(gymA, planA, -31, -2);
r = await renew(gymA, inGrace, { paid: 1500 });
check("in grace: starts today, full length, gap forgiven", day(r.membership.start_date) === today && day(r.membership.end_date) === shift(today, 29) && r.renewal.start_choice === "today");
const lapsed = await member(gymA, planA, -80, -50);
r = await renew(gymA, lapsed, { paid: 1500 });
check("lapsed: starts today", day(r.membership.start_date) === today);

const override = await member(gymA, planA, -80, -50);
r = await renew(gymA, override, { start: shift(today, -3), expected: today, paid: 1500 });
check("owner can choose another start date", day(r.membership.start_date) === shift(today, -3) && r.renewal.start_choice === "owner_date");
const clash = await member(gymA, planA, -20, 9);
check("an owner date that overlaps the running plan is refused", (await fails(renew(gymA, clash, { start: today }), /membership during those dates/)) === "ok");
check("stale screen (expected start changed) is refused", (await fails(renew(gymA, clash, { expected: today }), /dates changed/)) === "ok");
await renew(gymA, clash, { paid: 0 });
check("a booked future plan stops a second renewal", (await fails(renew(gymA, clash), /already has a plan starting/)) === "ok");

// discounts
const back = await member(gymA, planA, -80, -50);
r = await renew(gymA, back, { fee: 1350, reason: "welcome_back", paid: 1350 });
check("welcome back discount saved on the payment", Number(r.payment.discount_amount) === 150 && r.payment.discount_reason === "welcome_back", JSON.stringify(r.payment));
check("and on the renewal record", Number(r.renewal.discount_amount) === 150 && r.renewal.discount_reason === "welcome_back");
const manual = await member(gymA, planA, -80, -50);
r = await renew(gymA, manual, { fee: 1400, paid: 1400 });
check("an edited price without the button is a 'manual' discount", r.payment.discount_reason === "manual" && Number(r.payment.discount_amount) === 100);
const zero = await member(gymA, planA, -80, -50);
r = await renew(gymA, zero, { fee: 1350, reason: "welcome_back", paid: 0 });
check("nothing paid: no payment, the renewal still keeps the discount", r.payment === null && r.renewal.discount_reason === "welcome_back");
const fullPrice = await member(gymA, planA, -80, -50);
r = await renew(gymA, fullPrice, { reason: "welcome_back", paid: 1500 });
check("no discount means no reason, even if one was sent", r.payment.discount_reason === null && Number(r.payment.discount_amount) === 0);
const partial = await member(gymA, planA, -80, -50);
r = await renew(gymA, partial, { fee: 1500, paid: 600 });
check("partial payment leaves the balance", Number(r.renewal.fee) - Number(r.renewal.amount_paid) === 900);

// one transaction, one renewal
const u1 = await member(gymA, planA, -80, -50);
await renew(gymA, u1, { paid: 500, method: "upi", utr: "330000000001" });
const u2 = await member(gymA, planA, -80, -50);
const counts = async () => (await db.query("SELECT (SELECT count(*) FROM public.member_memberships)::int m, (SELECT count(*) FROM public.payments)::int p, (SELECT count(*) FROM public.membership_renewals)::int r")).rows[0];
const before = await counts();
check("duplicate UTR rolls everything back", (await fails(renew(gymA, u2, { paid: 500, method: "upi", utr: "330000000001" }), /duplicate|unique/i)) === "ok" && JSON.stringify(await counts()) === JSON.stringify(before));
const twice = await member(gymA, planA, -80, -50);
const k = key();
const first = await renew(gymA, twice, { key: k, paid: 1500 });
const again = await renew(gymA, twice, { key: k, paid: 1500 });
check("same key: one renewal, first answer returned", again.replayed && again.membership.id === first.membership.id && (await db.query("SELECT count(*)::int n FROM public.membership_renewals WHERE member_id = $1", [twice])).rows[0].n === 1);
const foreign = await member(gymB, planB, -80, -50);
check("another gym's member cannot be renewed", (await fails(renew(gymA, foreign), /Member not found/)) === "ok");
await db.exec("SET ROLE authenticated");
check("only the service role can call it", (await fails(renew(gymA, u2), /permission denied/)) === "ok");
await db.exec("RESET ROLE");

// the 019 version still works until it is removed
const old = await member(gymA, planA, -80, -50);
const oldResult = (await db.query("SELECT public.gympulse_renew_member($1, $2, $3, $4, false, null, null, 1500, 'cash', null, $5) AS r", [gymA, old, key(), planA, owner])).rows[0].r;
check("the 019 version still works (app between migration and deploy)", day(oldResult.membership.start_date) === today && oldResult.membership.grace_days === 3);

// lapsed renewal message can be logged (needs WhatsApp consent, as all messages do)
await db.query("SELECT * FROM public.gympulse_set_member_whatsapp_consent($1, $2, true, 'staff_form', NULL)", [gymA, lapsed]);
check("a 'lapsed' message can be logged", (await fails(db.query("INSERT INTO public.whatsapp_messages (gym_id, member_id, reminder_type) VALUES ($1, $2, 'lapsed')", [gymA, lapsed]), /^$/)) !== "no error" ? (await db.query("SELECT count(*)::int n FROM public.whatsapp_messages WHERE reminder_type = 'lapsed'")).rows[0].n === 1 : true);
check("an unknown message type is still refused", (await fails(db.query("INSERT INTO public.whatsapp_messages (gym_id, member_id, reminder_type) VALUES ($1, $2, 'spam')", [gymA, lapsed]), /reminder_type_valid/)) === "ok");

// gym deletion still erases everything
await db.query("UPDATE public.gyms SET deletion_requested_at = now() - interval '8 days', deletion_scheduled_for = now() - interval '1 day', deletion_requested_by = $2 WHERE id = $1", [gymA, owner]);
await db.exec("SET ROLE service_role");
check("gym deletion still works", (await fails(db.query("SELECT public.gympulse_delete_gym($1)", [gymA]), /^$/)) === "no error");
await db.exec("RESET ROLE");

for (const line of results) {
    test(line.slice(6).trim(), () => assert.ok(line.startsWith("PASS"), line));
}
