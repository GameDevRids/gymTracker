import { supabaseClient } from "../config/database.js";

const planColumns = "id,gym_id,name,description,duration_days,price,is_active,created_at,updated_at";

export class PlansServiceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function requireSupabaseClient(client) {
    if (!client) throw new PlansServiceError(503, "Supabase is not configured.");
}

function throwDatabaseError(error, operation) {
    if (error?.code === "23505") {
        throw new PlansServiceError(409, "A plan with this name already exists.");
    }
    if (error?.code === "23503" || (operation === "delete" && error?.code === "PGRST116")) {
        throw new PlansServiceError(409, "This plan has related membership or payment records. Deactivate it instead.");
    }
    if (error?.code === "PGRST204" || error?.code === "42703" || error?.code === "42P01") {
        throw new PlansServiceError(503, "The membership_plans table is unavailable. Run migration 003_create_membership_plans.sql in Supabase SQL Editor.");
    }
    throw new PlansServiceError(500, "The database could not complete the plan request.");
}

function withGymFilter(query) {
    return query.is("gym_id", null);
}

export async function listPlans({ page, limit, status, search }, client = supabaseClient) {
    requireSupabaseClient(client);
    const from = (page - 1) * limit;
    let query = withGymFilter(client
        .from("membership_plans")
        .select(planColumns, { count: "exact" })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + limit - 1));
    if (status) query = query.eq("is_active", status === "active");
    if (search) query = query.ilike("name", `%${search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);

    const { data, count, error } = await query;
    if (error) throwDatabaseError(error, "list");
    return { plans: data || [], total: count ?? 0 };
}

export async function getPlan(id, client = supabaseClient) {
    requireSupabaseClient(client);
    const { data, error } = await withGymFilter(client
        .from("membership_plans")
        .select(planColumns)
        .eq("id", id))
        .maybeSingle();
    if (error) throwDatabaseError(error, "get");
    if (!data) throw new PlansServiceError(404, "Plan not found.");
    return data;
}

export async function createPlan(plan, client = supabaseClient) {
    requireSupabaseClient(client);
    const { data, error } = await client
        .from("membership_plans")
        .insert({ ...plan, gym_id: null, is_active: plan.is_active ?? true })
        .select(planColumns)
        .single();
    if (error) throwDatabaseError(error, "create");
    return data;
}

export async function updatePlan(id, plan, client = supabaseClient) {
    requireSupabaseClient(client);
    const { data, error } = await withGymFilter(client
        .from("membership_plans")
        .update(plan)
        .eq("id", id))
        .select(planColumns)
        .maybeSingle();
    if (error) throwDatabaseError(error, "update");
    if (!data) throw new PlansServiceError(404, "Plan not found.");
    return data;
}

export async function deletePlan(id, client = supabaseClient) {
    requireSupabaseClient(client);
    const { data, error } = await withGymFilter(client
        .from("membership_plans")
        .delete()
        .eq("id", id))
        .select("id")
        .maybeSingle();
    if (error) throwDatabaseError(error, "delete");
    if (!data) throw new PlansServiceError(404, "Plan not found.");
}
