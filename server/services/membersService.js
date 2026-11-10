import { randomUUID } from "node:crypto";
import { supabaseClient } from "../config/database.js";
import { selectCurrentMembership } from "./membershipsService.js";

const memberColumns = [
    "id",
    "gym_id",
    "member_code",
    "full_name",
    "phone",
    "email",
    "gender",
    "date_of_birth",
    "membership_start_date",
    "membership_end_date",
    "status",
    "notes",
    "created_at",
    "updated_at",
    "archived_at"
].join(",");

export class MembersServiceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function throwDatabaseError(error, operation) {
    if (error?.code === "23505") {
        throw new MembersServiceError(409, "Member code already exists.");
    }
    if (operation === "create" && error?.code === "23502") {
        throw new MembersServiceError(503, "Member creation requires nullable membership dates. Review and apply migration 004_create_member_memberships.sql in Supabase SQL Editor.");
    }
    if (operation === "delete" && error?.code === "23503") {
        throw new MembersServiceError(409, "Member has related records and cannot be deleted.");
    }
    if (error?.code === "PGRST204" || error?.code === "42703") {
        throw new MembersServiceError(503, "The members table is missing required columns. Run the latest members migration in Supabase SQL Editor.");
    }
    if (error?.code === "PGRST205" || error?.code === "42P01") {
        throw new MembersServiceError(503, "Membership history is unavailable. Run migration 004_create_member_memberships.sql in Supabase SQL Editor.");
    }
    if (error?.code === "42501") {
        throw new MembersServiceError(503, "Supabase denied access to membership history. Check backend service-role access to member_memberships.");
    }
    throw new MembersServiceError(500, "The database could not complete the member request.");
}

function createMemberCode() {
    return `GP-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

function requireSupabaseClient(client = supabaseClient) {
    if (!client) {
        throw new MembersServiceError(503, "Supabase is not configured.");
    }
}

function withoutMembershipDates(member) {
    const {
        membership_start_date: _membershipStartDate,
        membership_end_date: _membershipEndDate,
        ...editableMember
    } = member;
    return editableMember;
}

const currentMembershipColumns = "id,gym_id,member_id,plan_id,plan_name,duration_days,price,total_fees,start_date,end_date,status,created_at,updated_at";

async function addCurrentMemberships(members, gymId, client) {
    if (!members.length) return members;
    const { data, error } = await client
        .from("member_memberships")
        .select(currentMembershipColumns)
        .in("member_id", members.map((member) => member.id))
        .eq("gym_id", gymId)
        .order("created_at", { ascending: false })
        .order("start_date", { ascending: false });
    if (error) throwDatabaseError(error, "membership-history");

    const membershipsByMember = new Map();
    for (const membership of data || []) {
        const history = membershipsByMember.get(membership.member_id) || [];
        history.push(membership);
        membershipsByMember.set(membership.member_id, history);
    }

    return members.map((member) => {
        const currentMembership = selectCurrentMembership(membershipsByMember.get(member.id) || []);
        return {
            ...member,
            current_membership: currentMembership,
            membership_status: currentMembership?.effective_status || "unassigned"
        };
    });
}

export async function listMembers({ page, limit, status, search, includeArchived = false, gymId }, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    const from = (page - 1) * limit;
    let query = client
        .from("members")
        .select(memberColumns, { count: "exact" })
        .eq("gym_id", gymId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + limit - 1);

    if (!includeArchived) query = query.is("archived_at", null);
    if (status) query = query.eq("status", status);
    if (search) {
        const escaped = search.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        const pattern = `"%${escaped}%"`;
        query = query.or(`full_name.ilike.${pattern},phone.ilike.${pattern},member_code.ilike.${pattern}`);
    }

    const { data, count, error } = await query;
    if (error) throwDatabaseError(error, "list");
    return { members: await addCurrentMemberships(data || [], gymId, client), total: count ?? 0 };
}

export async function getMember(id, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    const { data, error } = await client
        .from("members")
        .select(memberColumns)
        .eq("id", id)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (error) throwDatabaseError(error, "get");
    if (!data) throw new MembersServiceError(404, "Member not found.");
    return (await addCurrentMemberships([data], gymId, client))[0];
}

export async function createMember(member, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    const editableMember = withoutMembershipDates(member);
    const createdAt = new Date().toISOString();
    const hasSuppliedCode = Boolean(editableMember.member_code);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const record = {
            ...editableMember,
            member_code: editableMember.member_code || createMemberCode(),
            gym_id: gymId,
            status: member.status || "active",
            created_at: createdAt,
            updated_at: createdAt
        };
        const { data, error } = await client
            .from("members")
            .insert(record)
            .select(memberColumns)
            .single();

        if (!error) return data;
        if (error.code === "23505" && !hasSuppliedCode && attempt < 2) continue;
        throwDatabaseError(error, "create");
    }
    throw new MembersServiceError(500, "Could not generate a unique member code.");
}

export async function updateMember(id, member, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    const editableMember = withoutMembershipDates(member);
    if (Object.keys(editableMember).length === 0) {
        throw new MembersServiceError(400, "Provide at least one member field to update.");
    }
    const { data, error } = await client
        .from("members")
        .update({ ...editableMember, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .select(memberColumns)
        .maybeSingle();
    if (error) throwDatabaseError(error, "update");
    if (!data) throw new MembersServiceError(404, "Member not found.");
    return data;
}

export async function deleteMember(id, gymId, client = supabaseClient) {
    requireSupabaseClient(client);
    if (!gymId) throw new MembersServiceError(403, "Gym is required.");
    const archivedAt = new Date().toISOString();
    const { data, error } = await client
        .from("members")
        .update({ archived_at: archivedAt, updated_at: archivedAt })
        .eq("id", id)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .select("id")
        .maybeSingle();
    if (error) throwDatabaseError(error, "delete");
    if (!data) throw new MembersServiceError(404, "Member not found.");
}
