import { supabaseClient } from "../config/database.js";
import { DEFAULT_LAPSED_LIST_DAYS, memberStatusFor, remindable } from "../../assets/js/memberStatus.js";

// Every member's status (assets/js/memberStatus.js) for one gym, for the Expiring board, the
// Lapsed and Old members lists and the Overview counts. Worked out from dates when asked.

export class MemberStatusError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const PAGE = 1000;
const MISSING = ["PGRST204", "PGRST205", "42703", "42P01"];
const membershipColumns = "id,gym_id,member_id,plan_id,plan_name,duration_days,price,total_fees,grace_days,start_date,end_date,status,created_at";
const holdColumns = "id,gym_id,member_id,membership_id,starts_on,planned_return_on,latest_return_on,remaining_days,end_before";
// Before migration 021 there is no holds table: nobody is on hold, and everything else still works.
const NO_HOLDS = ["PGRST202", "PGRST205", "42883", "42P01"];

export function indiaToday(now = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function databaseError(error) {
    if (MISSING.includes(error?.code)) {
        return new MemberStatusError(503, "Member statuses need the latest database update. Run migration 020_add_grace_and_lapsed_members.sql and then 021_add_plan_holds.sql in Supabase SQL Editor.");
    }
    return new MemberStatusError(500, "The database could not work out member statuses.");
}

/**
 * Saves the holds whose return date (or maximum) has passed: the plan's end moves later by the
 * days held. Done whenever members are read, so no nightly job is needed. memberId limits it to one
 * member. Never fails the caller: statuses are also worked out from dates (applyHolds).
 */
export async function settleHolds(gymId, memberId = null, client = supabaseClient) {
    try {
        const { error } = await client.rpc("gympulse_settle_holds", { p_gym_id: gymId, p_member_id: memberId });
        return error ? 0 : 1;
    } catch {
        return 0;
    }
}

/** The gym's holds that are not cancelled or ended: running, or booked to start. */
export async function openHolds(gymId, client = supabaseClient, memberIds = null) {
    const rows = [];
    const parts = memberIds ? Array.from({ length: Math.ceil(memberIds.length / 150) }, (_, index) => memberIds.slice(index * 150, index * 150 + 150)) : [null];
    for (const part of parts) {
        for (let from = 0; ; from += PAGE) {
            let query = client.from("membership_holds").select(holdColumns).eq("gym_id", gymId).eq("cancelled", false).is("ended_on", null);
            if (part) query = query.in("member_id", part);
            const { data, error } = await query.order("id", { ascending: true }).range(from, from + PAGE - 1);
            if (error) {
                if (NO_HOLDS.includes(error.code)) return [];
                throw databaseError(error);
            }
            rows.push(...(data || []));
            if (!data || data.length < PAGE) break;
        }
    }
    return rows;
}

/** The gym's rules for statuses: lapsed_list_days and the default grace for older plans. */
export async function gymStatusRules(gymId, client = supabaseClient) {
    const { data, error } = await client.from("gyms").select("expiry_grace_days,lapsed_list_days").eq("id", gymId).maybeSingle();
    if (error) throw databaseError(error);
    return {
        lapsedListDays: Number.isInteger(data?.lapsed_list_days) ? data.lapsed_list_days : DEFAULT_LAPSED_LIST_DAYS,
        defaultGraceDays: Number.isInteger(data?.expiry_grace_days) ? data.expiry_grace_days : 0
    };
}

async function readAll(query) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await query().range(from, from + PAGE - 1);
        if (error) throw databaseError(error);
        rows.push(...(data || []));
        if (!data || data.length < PAGE) return rows;
    }
}

/**
 * [{ member, state }] for every current (not archived) member of the gym. state is
 * memberStatusFor(...) plus remindable (the Expiring board's WhatsApp button).
 */
export async function memberStatuses(gymId, client = supabaseClient, today = indiaToday()) {
    if (!client) throw new MemberStatusError(503, "Supabase is not configured.");
    if (!gymId) throw new MemberStatusError(403, "Gym is required.");
    await settleHolds(gymId, null, client);
    const [rules, members, memberships, holds] = await Promise.all([
        gymStatusRules(gymId, client),
        readAll(() => client.from("members").select("id,full_name,member_code,phone,whatsapp_opt_in,status,created_at")
            .eq("gym_id", gymId).is("archived_at", null).order("id", { ascending: true })),
        readAll(() => client.from("member_memberships").select(membershipColumns)
            .eq("gym_id", gymId).order("id", { ascending: true })),
        openHolds(gymId, client)
    ]);
    const holdsByMember = new Map();
    for (const hold of holds) holdsByMember.set(hold.member_id, [...(holdsByMember.get(hold.member_id) || []), hold]);
    const byMember = new Map();
    for (const membership of memberships) {
        const list = byMember.get(membership.member_id) || [];
        list.push(membership);
        byMember.set(membership.member_id, list);
    }
    return members.map((member) => {
        const state = memberStatusFor(byMember.get(member.id) || [], today, { ...rules, holds: holdsByMember.get(member.id) || [] });
        return { member: { ...member, whatsapp_opt_in: member.whatsapp_opt_in === true }, state: { ...state, remindable: remindable(state) }, rules, history: byMember.get(member.id) || [] };
    });
}

/** How many members are in each status, for the Overview. */
export function countStatuses(rows) {
    const counts = { active: 0, expiring: 0, upcoming: 0, in_grace: 0, lapsed: 0, old: 0, none: 0, on_hold: 0 };
    for (const { state } of rows) counts[state.status] = (counts[state.status] || 0) + 1;
    return counts;
}

const minusDays = (date, days) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() - days);
    return value.toISOString().slice(0, 10);
};

export const RENEWAL_WINDOW_DAYS = 30;
export const INACTIVE_DAYS = 14;

/**
 * The renewal rate, one definition for every screen: "due" is each member whose plan ended in the
 * last 30 days (yesterday back to 30 days ago); "renewed" is those of them who now have a newer plan
 * (one that starts after the plan that ended). Members on hold are left out: their plan is paused.
 * Returns { due, renewed }.
 */
export function renewalStats(rows, today = indiaToday()) {
    const from = minusDays(today, RENEWAL_WINDOW_DAYS);
    let due = 0;
    let renewed = 0;
    for (const { state, history = [] } of rows) {
        if (state.status === "on_hold") continue;
        const plans = history.filter((plan) => plan.status !== "cancelled");
        const ended = plans.filter((plan) => plan.end_date >= from && plan.end_date < today)
            .sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
        if (!ended) continue;
        due += 1;
        if (plans.some((plan) => plan.start_date > ended.start_date && plan.id !== ended.id)) renewed += 1;
    }
    return { due, renewed };
}

/**
 * Members who may need a check-in: a current plan (active or expiring), and no visit in the last
 * 14 days counted from the later of their join date and their last visit, so a member who joined
 * less than 14 days ago is never counted. recentVisitors: ids of members with a visit in those 14 days.
 */
export function inactiveCount(rows, recentVisitors, today = indiaToday()) {
    const joinedBy = minusDays(today, INACTIVE_DAYS);
    return rows.filter(({ member, state }) => (state.status === "active" || state.status === "expiring")
        && !recentVisitors.has(member.id)
        && String(member.created_at || "").slice(0, 10) <= joinedBy).length;
}

/** Ids of the gym's members with a check-in in the last 14 days (today included). */
export async function recentVisitorIds(gymId, client = supabaseClient, today = indiaToday()) {
    const rows = await readAll(() => client.from("attendance").select("member_id").eq("gym_id", gymId)
        .gte("check_in_date", minusDays(today, INACTIVE_DAYS - 1)).order("member_id", { ascending: true }));
    return new Set(rows.map((row) => row.member_id));
}

/** One row of a status list, in the shape the app's lists use. */
export function statusRow({ member, state }) {
    const membership = state.membership || {};
    return {
        ...membership,
        member,
        member_status: state.status,
        days_left: state.daysLeft ?? (state.endedOn ? -state.daysSinceEnd : null),
        ended_on: state.endedOn || null,
        days_since_end: state.daysSinceEnd,
        grace_days: state.graceDays,
        grace_until: state.graceUntil || null,
        grace_days_left: state.graceDaysLeft,
        remindable: state.remindable === true
    };
}

/** Expiring soon: expiring and in-grace members, the plan ending soonest first. */
export async function listExpiring(gymId, client = supabaseClient, today = indiaToday()) {
    const rows = (await memberStatuses(gymId, client, today)).filter(({ state }) => state.status === "expiring" || state.status === "in_grace");
    return rows.map(statusRow).sort((a, b) => a.end_date.localeCompare(b.end_date) || a.member.full_name.localeCompare(b.member.full_name));
}

/**
 * Lapsed (list = "lapsed") or old (list = "old") members, the most recently ended first, each
 * with when a renewal message was last sent to them (reminder_type 'lapsed').
 */
export async function listLapsed(gymId, list = "lapsed", client = supabaseClient, today = indiaToday()) {
    const rows = (await memberStatuses(gymId, client, today)).filter(({ state }) => state.status === list).map(statusRow)
        .sort((a, b) => String(b.ended_on).localeCompare(String(a.ended_on)) || a.member.full_name.localeCompare(b.member.full_name));
    const sent = new Map();
    const ids = rows.map((row) => row.member.id);
    for (let index = 0; index < ids.length; index += 200) {
        const { data, error } = await client.from("whatsapp_messages").select("member_id,created_at")
            .eq("gym_id", gymId).eq("reminder_type", "lapsed").in("member_id", ids.slice(index, index + 200));
        // Before migration 020 nothing can have been sent; the list still shows.
        if (error) break;
        for (const message of data || []) {
            if (!sent.has(message.member_id) || message.created_at > sent.get(message.member_id)) sent.set(message.member_id, message.created_at);
        }
    }
    return rows.map((row) => ({ ...row, renewal_message_sent_at: sent.get(row.member.id) || null }));
}
