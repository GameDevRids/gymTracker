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

export function indiaToday(now = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function databaseError(error) {
    if (MISSING.includes(error?.code)) {
        return new MemberStatusError(503, "Member statuses need the latest database update. Run migration 020_add_grace_and_lapsed_members.sql in Supabase SQL Editor.");
    }
    return new MemberStatusError(500, "The database could not work out member statuses.");
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
    const [rules, members, memberships] = await Promise.all([
        gymStatusRules(gymId, client),
        readAll(() => client.from("members").select("id,full_name,member_code,phone,whatsapp_opt_in,status")
            .eq("gym_id", gymId).is("archived_at", null).order("id", { ascending: true })),
        readAll(() => client.from("member_memberships").select(membershipColumns)
            .eq("gym_id", gymId).order("id", { ascending: true }))
    ]);
    const byMember = new Map();
    for (const membership of memberships) {
        const list = byMember.get(membership.member_id) || [];
        list.push(membership);
        byMember.set(membership.member_id, list);
    }
    return members.map((member) => {
        const state = memberStatusFor(byMember.get(member.id) || [], today, rules);
        return { member: { ...member, whatsapp_opt_in: member.whatsapp_opt_in === true }, state: { ...state, remindable: remindable(state) }, rules };
    });
}

/** How many members are in each status, for the Overview. */
export function countStatuses(rows) {
    const counts = { active: 0, expiring: 0, upcoming: 0, in_grace: 0, lapsed: 0, old: 0, none: 0 };
    for (const { state } of rows) counts[state.status] = (counts[state.status] || 0) + 1;
    return counts;
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
