import { supabaseClient } from "../config/database.js";
import { sessionPreferences } from "./gymSettingsService.js";
import { loadGymMembership } from "../middleware/requireAuth.js";

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

async function authRequest(path, body, token, method = "POST") {
    let response;
    try {
        response = await fetch(`${process.env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/${path}`, {
            method,
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

// Supabase Auth reports errors as { error_code, msg } (newer) or { error, error_description }.
const errorCode = (error) => String(error?.error_code || error?.code || error?.error || "");
const errorText = (error) => String(error?.msg || error?.error_description || error?.message || "");

// Demo gyms are listed by ID in DEMO_GYM_IDS; only they may load fictional sample data.
export function isDemoGym(gymId, environment = process.env) {
    if (!gymId) return false;
    return String(environment.DEMO_GYM_IDS || "").split(",").map((id) => id.trim()).filter(Boolean).includes(gymId);
}

async function getGym(userId, client) {
    const { data, error } = await loadGymMembership(client, userId);
    if (error) throw new AuthServiceError(503, "Gym membership could not be loaded.");
    if (!data?.gyms) return null;
    // The gym's language and date format, so the first screen is already in the right language.
    const preferences = await sessionPreferences(data.gyms.id, client);
    // A gym waiting to be erased opens the "scheduled for deletion" screen instead of the app.
    const deletion = data.gyms.deletion_scheduled_for
        ? { deletion: { requested_at: data.gyms.deletion_requested_at, scheduled_for: data.gyms.deletion_scheduled_for } }
        : {};
    return { id: data.gyms.id, name: data.gyms.name, is_demo: isDemoGym(data.gyms.id), role: data.role || "owner", ...preferences, ...deletion };
}

// A sign-in that failed: a clear reason for the owner, never Supabase's internal wording.
function signInFailure(result) {
    if (result.status === 429) throw new AuthServiceError(429, "Too many sign-in attempts. Please wait 15 minutes and try again.");
    if (/not.?confirmed/i.test(`${errorCode(result.error)} ${errorText(result.error)}`)) {
        throw new AuthServiceError(401, "Confirm your email address first: open the link in the email you were sent when the account was made.");
    }
    throw new AuthServiceError(401, "Email or password is incorrect.");
}

function refreshFailure(result) {
    if (result.status === 429) throw new AuthServiceError(429, "Too many sign-in attempts. Please wait 15 minutes and try again.");
    throw new AuthServiceError(401, "Your session has expired. Sign in again.");
}

export async function login({ email, password }, client = supabaseClient) {
    requireClient(client);
    const result = await authRequest("token?grant_type=password", { email, password });
    if (result.error || !result.data?.access_token || !result.data?.user) signInFailure(result);
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
    if (result.error || !result.data?.access_token || !result.data?.user) refreshFailure(result);
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
    return { id: gym.id, name: gym.name, is_demo: isDemoGym(gym.id) };
}

export async function logout(accessToken, client = supabaseClient) {
    requireClient(client);
    const result = await authRequest("logout", {}, accessToken);
    if (result.error) throw new AuthServiceError(503, "The session could not be revoked.");
}

// ---------- Passwords ----------

/** Why Supabase refused a new password, in words the owner can act on. */
function newPasswordFailure(result, { expiredMessage }) {
    const code = errorCode(result.error);
    const text = errorText(result.error);
    if (result.status === 401 || result.status === 403 || /jwt|session|expired|not.?found/i.test(code)) {
        throw new AuthServiceError(401, expiredMessage);
    }
    if (/same_password/i.test(code) || /different from the old/i.test(text)) {
        throw new AuthServiceError(400, "Choose a password that is different from your old one.");
    }
    if (/weak_password/i.test(code) || result.status === 422) {
        throw new AuthServiceError(400, text && text.length < 200 ? text : "Choose a longer, harder to guess password.");
    }
    if (result.status === 429) throw new AuthServiceError(429, "Too many attempts. Please wait a few minutes and try again.");
    throw new AuthServiceError(503, "The password could not be changed. Please try again.");
}

/**
 * Asks Supabase to email a password-reset link that opens redirectTo (the app's
 * /reset-password page). Supabase answers the same whether or not the email has an account,
 * so nobody can use this to find out who has one.
 */
export async function requestPasswordReset(email, redirectTo, client = supabaseClient) {
    requireClient(client);
    const result = await authRequest(`recover?redirect_to=${encodeURIComponent(redirectTo)}`, { email });
    if (!result.error) return;
    if (result.status === 429 || /rate_limit/i.test(errorCode(result.error))) {
        throw new AuthServiceError(429, "A reset email was sent a moment ago. Wait a minute, then try again.");
    }
    // Supabase does not say whether an address exists; neither do we.
    if (result.status === 400 || result.status === 404 || result.status === 422) return;
    throw new AuthServiceError(503, "The reset email could not be sent right now. Please try again later.");
}

/**
 * Sets a new password with the short-lived session from a reset link, then signs the account
 * out everywhere (every device must sign in with the new password).
 */
export async function resetPassword(accessToken, password, client = supabaseClient) {
    requireClient(client);
    const result = await authRequest("user", { password }, accessToken, "PUT");
    if (result.error) newPasswordFailure(result, { expiredMessage: "This reset link has expired or was already used. Ask for a new one." });
    await authRequest("logout?scope=global", {}, accessToken).catch(() => null);
}

/**
 * Changes the password of a signed-in owner. The current password is checked by signing in
 * with it, which also gives a fresh session; the password is changed with that session, other
 * devices are signed out, and this device continues with the fresh session.
 */
async function signInToCheck(email, password) {
    const check = await authRequest("token?grant_type=password", { email, password });
    if (check.error || !check.data?.access_token) {
        if (check.status === 429) throw new AuthServiceError(429, "Too many attempts. Please wait 15 minutes and try again.");
        throw new AuthServiceError(400, "Your current password is not right.");
    }
    return check.data;
}

/**
 * Checks a signed-in user's password before something that cannot be undone easily (deleting
 * the gym). The session the check creates is ended at once.
 */
export async function verifyPassword(email, password) {
    if (!email || !password) throw new AuthServiceError(400, "Enter your password to confirm.");
    const session = await signInToCheck(email, password);
    await authRequest("logout?scope=local", {}, session.access_token).catch(() => null);
}

export async function changePassword(email, currentPassword, newPassword, client = supabaseClient) {
    requireClient(client);
    const session = await signInToCheck(email, currentPassword);
    const result = await authRequest("user", { password: newPassword }, session.access_token, "PUT");
    if (result.error) newPasswordFailure(result, { expiredMessage: "Your session has expired. Sign in again and try once more." });
    await authRequest("logout?scope=others", {}, session.access_token).catch(() => null);
    const gym = await getGym(session.user.id, client);
    return {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
        user: { id: session.user.id, email: session.user.email },
        gym
    };
}
