import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL?.trim() || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
const placeholderValue = /^your_/i;

function isValidSupabaseUrl(value) {
    if (!value || placeholderValue.test(value)) return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
    } catch {
        return false;
    }
}

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
