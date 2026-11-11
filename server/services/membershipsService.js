import { supabaseClient, supabaseConfigurationError } from "../config/database.js";
import { logger } from "../config/logger.js";

const membershipColumns = "id,gym_id,member_id,plan_id,plan_name,duration_days,price,total_fees,start_date,end_date,status,created_at,updated_at";

export class MembershipsServiceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function requireSupabaseClient(client) {
    if (!client) {
        throw new MembershipsServiceError(503, supabaseConfigurationError || "Supabase is not configured.");
    }
}

function currentIndiaDate() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
}

export function effectiveMembershipStatus(membership, today = currentIndiaDate()) {
    if (membership.status === "cancelled") return "cancelled";
    if (membership.start_date > today) return "upcoming";
    if (membership.end_date < today) return "expired";
    return "active";
}

function withEffectiveStatus(membership) {
    return { ...membership, effective_status: effectiveMembershipStatus(membership) };
}

export function selectCurrentMembership(memberships, today = currentIndiaDate()) {
    const evaluated = memberships.map((membership) => ({
        ...membership,
        effective_status: effectiveMembershipStatus(membership, today)
    }));
    return evaluated.find((membership) => membership.effective_status === "active")
        || evaluated
            .filter((membership) => membership.effective_status === "upcoming")
            .sort((a, b) => a.start_date.localeCompare(b.start_date)
                || b.created_at.localeCompare(a.created_at))[0]
        || evaluated.sort((a, b) => b.created_at.localeCompare(a.created_at)
            || b.start_date.localeCompare(a.start_date))[0]
        || null;
}

function throwDatabaseError(error) {
    if (error?.code === "42501") {
        logger.error({ code: error.code }, "Supabase membership access denied.");
        throw new MembershipsServiceError(
            503,
            supabaseConfigurationError
                ? `Membership history requires backend service credentials. ${supabaseConfigurationError}`
                : "Supabase denied access to membership history. Check the backend service-role key and the member_memberships table grants."
        );
    }
    if (error?.code === "P0002") {
        throw new MembershipsServiceError(404, error.message || "Member or plan not found.");
    }
    if (error?.code === "23P01") {
        throw new MembershipsServiceError(409, "This member already has a membership during those dates.");
    }
    if (error?.code === "P0001") {
        throw new MembershipsServiceError(409, error.message || "Only active plans can be assigned.");
    }
    if (error?.code === "23503") {
        throw new MembershipsServiceError(409, "Membership history prevents this record from being deleted.");
    }
    if (error?.code === "PGRST202" || error?.code === "PGRST204" || error?.code === "PGRST205" || error?.code === "42703" || error?.code === "42P01") {
        throw new MembershipsServiceError(503, "Membership history is unavailable. Run migration 004_create_member_memberships.sql in Supabase SQL Editor.");
    }
    throw new MembershipsServiceError(500, "The database could not complete the membership request.");
}

function isMissingRpc(error) {
    return error?.code === "PGRST202" || error?.code === "42883";
}

export async function listMemberMemberships(memberId, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembershipsServiceError(403, "Gym is required.");
    const { data: member, error: memberError } = await client
        .from("members")
        .select("id")
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (memberError) throwDatabaseError(memberError);
    if (!member) throw new MembershipsServiceError(404, "Member not found.");
    const { data, error } = await client
        .from("member_memberships")
        .select(membershipColumns)
        .eq("member_id", memberId)
        .eq("gym_id", gymId)
        .order("start_date", { ascending: false })
        .order("created_at", { ascending: false });
    if (error) throwDatabaseError(error);
    return (data || []).map(withEffectiveStatus);
}

export async function assignMemberPlan(memberId, { plan_id, start_date, total_fees }, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembershipsServiceError(403, "Gym is required.");
    const { data, error } = await client.rpc("gympulse_assign_member_plan", {
        p_member_id: memberId,
        p_plan_id: plan_id,
        p_start_date: start_date,
        p_gym_id: gymId,
        p_total_fees: total_fees ?? null
    });
    if (error) {
        if (isMissingRpc(error)) {
            throw new MembershipsServiceError(503, "Gym-scoped membership assignment is unavailable. Run migrations 004_create_member_memberships.sql and 007_create_gyms_and_auth.sql in Supabase SQL Editor.");
        }
        throwDatabaseError(error);
    }
    const membership = Array.isArray(data) ? data[0] : data;
    if (!membership) throw new MembershipsServiceError(500, "The database did not return the created membership.");
    return withEffectiveStatus(membership);
}

export async function getMembership(id, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembershipsServiceError(403, "Gym is required.");
    const { data, error } = await client
        .from("member_memberships")
        .select(membershipColumns)
        .eq("id", id)
        .eq("gym_id", gymId)
        .maybeSingle();
    if (error) throwDatabaseError(error);
    if (!data) throw new MembershipsServiceError(404, "Membership not found.");
    return withEffectiveStatus(data);
}

export async function listMemberships({ page, limit, gymId }, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembershipsServiceError(403, "Gym is required.");
    const from = (page - 1) * limit;
    const { data, count, error } = await client
        .from("member_memberships")
        .select(membershipColumns, { count: "exact" })
        .eq("gym_id", gymId)
        .order("start_date", { ascending: false })
        .order("created_at", { ascending: false })
        .range(from, from + limit - 1);
    if (error) throwDatabaseError(error);
    return { memberships: (data || []).map(withEffectiveStatus), total: count ?? 0 };
}

export async function listExpiringMemberships({ days, gymId }, client = supabaseClient, today = currentIndiaDate()) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembershipsServiceError(403, "Gym is required.");
    const records = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await client
            .from("member_memberships")
            .select(`${membershipColumns},members!member_memberships_member_id_fkey!inner(id,full_name,phone,archived_at,status,whatsapp_opt_in)`)
            .eq("gym_id", gymId)
            .eq("members.gym_id", gymId)
            .is("members.archived_at", null)
            .eq("status", "assigned")
            .order("end_date", { ascending: true })
            .order("created_at", { ascending: false })
            .range(offset, offset + pageSize - 1);
        if (error) throwDatabaseError(error);
        records.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }

    const membershipsByMember = new Map();
    for (const membership of records) {
        const history = membershipsByMember.get(membership.member_id) || [];
        history.push(membership);
        membershipsByMember.set(membership.member_id, history);
    }

    const todayDate = new Date(`${today}T00:00:00.000Z`);
    return [...membershipsByMember.values()]
        .map((history) => {
            const membership = selectCurrentMembership(history, today);
            if (!membership) return null;
            const member = membership.members;
            const daysLeft = Math.floor((new Date(`${membership.end_date}T00:00:00.000Z`) - todayDate) / 86400000);
            return {
                ...membership,
                member: {
                    id: member.id,
                    full_name: member.full_name,
                    phone: member.phone,
                    whatsapp_opt_in: member.whatsapp_opt_in === true
                },
                days_left: daysLeft
            };
        })
        .filter((membership) => membership
            && (membership.effective_status === "expired"
                || (membership.effective_status === "active" && membership.days_left <= days)))
        .sort((first, second) => first.end_date.localeCompare(second.end_date)
            || first.member.full_name.localeCompare(second.member.full_name));
}
