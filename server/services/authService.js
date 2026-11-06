import { supabaseClient } from "../config/database.js";

export class AuthServiceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function requireClient(client) {
    if (!client) throw new AuthServiceError(503, "Authentication service is unavailable.");
}

function authHeaders(token) {
    return {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
}

async function authRequest(path, body, token) {
    let response;
    try {
        response = await fetch(`${process.env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/${path}`, {
            method: "POST",
            headers: authHeaders(token),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000)
        });
    } catch {
        throw new AuthServiceError(503, "Authentication service is unavailable.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { error: data, status: response.status };
    return { data };
}

async function getGym(userId, client) {
    const { data, error } = await client
        .from("gym_users")
        .select("gym_id,gyms(id,name)")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) throw new AuthServiceError(503, "Gym membership could not be loaded.");
    return data?.gyms ? { id: data.gyms.id, name: data.gyms.name } : null;
}

function authFailure(error) {
    throw new AuthServiceError(401, error?.message || "Email or password is incorrect.");
}

export async function login({ email, password }, client = supabaseClient) {
    requireClient(client);
    const result = await authRequest("token?grant_type=password", { email, password });
    if (result.error || !result.data?.access_token || !result.data?.user) authFailure(result.error);
    const data = result.data;
    const gym = await getGym(data.user.id, client);
    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        user: { id: data.user.id, email: data.user.email },
        gym
    };
}

export async function refresh(refreshToken, client = supabaseClient) {
    requireClient(client);
    const result = await authRequest("token?grant_type=refresh_token", { refresh_token: refreshToken });
    if (result.error || !result.data?.access_token || !result.data?.user) authFailure(result.error);
    const data = result.data;
    const gym = await getGym(data.user.id, client);
    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        user: { id: data.user.id, email: data.user.email },
        gym
    };
}

export async function createGym(name, ownerUserId, client = supabaseClient) {
    requireClient(client);
    const { data, error } = await client.rpc("gympulse_create_or_claim_gym", {
        p_name: name,
        p_owner_user_id: ownerUserId
    });
    if (error) {
        if (error.code === "23505") throw new AuthServiceError(409, "This account already belongs to a gym.");
        if (error.code === "PGRST202" || error.code === "42883") {
            throw new AuthServiceError(503, "Gym onboarding is unavailable. Run migration 007_create_gyms_and_auth.sql.");
        }
        throw new AuthServiceError(500, "The gym could not be created or the existing workspace could not be claimed.");
    }
    const gym = Array.isArray(data) ? data[0] : data;
    if (!gym?.id) throw new AuthServiceError(500, "The database did not return the created gym.");
    return { id: gym.id, name: gym.name };
}

export async function logout(accessToken, client = supabaseClient) {
    requireClient(client);
    const result = await authRequest("logout", {}, accessToken);
    if (result.error) throw new AuthServiceError(503, "The session could not be revoked.");
}
