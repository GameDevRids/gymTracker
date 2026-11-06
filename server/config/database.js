import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL?.trim() || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
const placeholderValue = /^your_/i;

export function getServiceRoleKeyError(value) {
    if (!value) return "SUPABASE_SERVICE_ROLE_KEY is missing.";
    if (value.startsWith("sb_publishable_")) {
        return "SUPABASE_SERVICE_ROLE_KEY contains a Supabase publishable key, which cannot access membership history.";
    }
    if (value.startsWith("sb_secret_")) return null;

    const parts = value.split(".");
    if (parts.length === 3) {
        try {
            const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
            if (payload.role === "service_role") return null;
            if (payload.role === "anon") {
                return "SUPABASE_SERVICE_ROLE_KEY contains an anon key, which cannot access membership history.";
            }
        } catch {
            return "SUPABASE_SERVICE_ROLE_KEY must be a Supabase secret key or a service_role JWT.";
        }
    }
    return "SUPABASE_SERVICE_ROLE_KEY must be a Supabase secret key or a service_role JWT.";
}

function isValidSupabaseUrl(value) {
    if (!value || placeholderValue.test(value)) return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
    } catch {
        return false;
    }
}

export const supabaseConfigurationError = !isValidSupabaseUrl(supabaseUrl)
    ? "SUPABASE_URL is missing or invalid."
    : placeholderValue.test(serviceRoleKey)
        ? "SUPABASE_SERVICE_ROLE_KEY contains a placeholder value."
        : getServiceRoleKeyError(serviceRoleKey);
export const supabaseConfigured = isValidSupabaseUrl(supabaseUrl)
    && Boolean(serviceRoleKey)
    && !placeholderValue.test(serviceRoleKey);

export const supabaseClient = supabaseConfigured
    ? createClient(supabaseUrl, serviceRoleKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    })
    : null;
