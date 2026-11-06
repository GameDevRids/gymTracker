import { randomUUID } from "node:crypto";
import { supabaseClient } from "../config/database.js";

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
    "updated_at"
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

export async function listMembers({ page, limit, status, search }) {
    requireSupabaseClient();
    const from = (page - 1) * limit;
    let query = supabaseClient
        .from("members")
        .select(memberColumns, { count: "exact" })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + limit - 1);

    if (status) query = query.eq("status", status);
    if (search) {
        const escaped = search.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        const pattern = `"%${escaped}%"`;
        query = query.or(`full_name.ilike.${pattern},phone.ilike.${pattern},member_code.ilike.${pattern}`);
    }

    const { data, count, error } = await query;
    if (error) throwDatabaseError(error, "list");
    return { members: data, total: count ?? 0 };
}

export async function getMember(id) {
    requireSupabaseClient();
    const { data, error } = await supabaseClient
        .from("members")
        .select(memberColumns)
        .eq("id", id)
        .maybeSingle();
    if (error) throwDatabaseError(error, "get");
    if (!data) throw new MembersServiceError(404, "Member not found.");
    return data;
}

export async function createMember(member, client = supabaseClient) {
    requireSupabaseClient(client);
    const editableMember = withoutMembershipDates(member);
    const createdAt = new Date().toISOString();
    const hasSuppliedCode = Boolean(editableMember.member_code);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const record = {
            ...editableMember,
            member_code: editableMember.member_code || createMemberCode(),
            gym_id: null,
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

export async function updateMember(id, member, client = supabaseClient) {
    requireSupabaseClient(client);
    const editableMember = withoutMembershipDates(member);
    if (Object.keys(editableMember).length === 0) {
        throw new MembersServiceError(400, "Provide at least one member field to update.");
    }
    const { data, error } = await client
        .from("members")
        .update({ ...editableMember, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select(memberColumns)
        .maybeSingle();
    if (error) throwDatabaseError(error, "update");
    if (!data) throw new MembersServiceError(404, "Member not found.");
    return data;
}

export async function deleteMember(id) {
    requireSupabaseClient();
    const { data: existing, error: lookupError } = await supabaseClient
        .from("members")
        .select(memberColumns)
        .eq("id", id)
        .maybeSingle();
    if (lookupError) throwDatabaseError(lookupError, "get");
    if (!existing) throw new MembersServiceError(404, "Member not found.");

    const { data, error } = await supabaseClient
        .from("members")
        .delete()
        .eq("id", id)
        .select("id")
        .maybeSingle();
    if (error) throwDatabaseError(error, "delete");
    if (!data) throw new MembersServiceError(404, "Member not found.");
}
