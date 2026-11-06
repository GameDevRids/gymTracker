import { supabaseClient } from "../config/database.js";

const membershipColumns = "id,gym_id,member_id,plan_id,plan_name,duration_days,price,start_date,end_date,status,created_at,updated_at";

export class MembershipsServiceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function requireSupabaseClient(client) {
    if (!client) throw new MembershipsServiceError(503, "Supabase is not configured.");
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

function throwDatabaseError(error) {
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

export async function listMemberMemberships(memberId, client = supabaseClient) {
    requireSupabaseClient(client);
    const { data: member, error: memberError } = await client
        .from("members")
        .select("id")
        .eq("id", memberId)
        .is("gym_id", null)
        .maybeSingle();
    if (memberError) throwDatabaseError(memberError);
    if (!member) throw new MembershipsServiceError(404, "Member not found.");
    const { data, error } = await client
        .from("member_memberships")
        .select(membershipColumns)
        .eq("member_id", memberId)
        .is("gym_id", null)
        .order("start_date", { ascending: false })
        .order("created_at", { ascending: false });
    if (error) throwDatabaseError(error);
    return (data || []).map(withEffectiveStatus);
}

export async function assignMemberPlan(memberId, { plan_id, start_date }, client = supabaseClient) {
    requireSupabaseClient(client);
    const { data, error } = await client.rpc("gympulse_assign_member_plan", {
        p_member_id: memberId,
        p_plan_id: plan_id,
        p_start_date: start_date
    });
    if (error) {
        if (isMissingRpc(error)) {
            throw new MembershipsServiceError(503, "Membership history is unavailable. Run migration 004_create_member_memberships.sql in Supabase SQL Editor.");
        }
        throwDatabaseError(error);
    }
    const membership = Array.isArray(data) ? data[0] : data;
    if (!membership) throw new MembershipsServiceError(500, "The database did not return the created membership.");
    return withEffectiveStatus(membership);
}

export async function getMembership(id, client = supabaseClient) {
    requireSupabaseClient(client);
    const { data, error } = await client
        .from("member_memberships")
        .select(membershipColumns)
        .eq("id", id)
        .is("gym_id", null)
        .maybeSingle();
    if (error) throwDatabaseError(error);
    if (!data) throw new MembershipsServiceError(404, "Membership not found.");
    return withEffectiveStatus(data);
}

export async function listMemberships({ page, limit }, client = supabaseClient) {
    requireSupabaseClient(client);
    const from = (page - 1) * limit;
    const { data, count, error } = await client
        .from("member_memberships")
        .select(membershipColumns, { count: "exact" })
        .is("gym_id", null)
        .order("start_date", { ascending: false })
        .order("created_at", { ascending: false })
        .range(from, from + limit - 1);
    if (error) throwDatabaseError(error);
    return { memberships: (data || []).map(withEffectiveStatus), total: count ?? 0 };
}
