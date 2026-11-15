// Removes personal data and secrets from text before it is logged or sent to Sentry:
// phone numbers, email addresses, sign-in tokens, long random tokens (QR, poster, refresh),
// the values Postgres puts in error details, and quoted text (where names usually appear).

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// Indian mobiles: optional +91 / 91 / 0, then 10 digits starting 6–9, with spaces or dashes.
const PHONE = /(?<![\dA-Za-z])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\dA-Za-z])/g;
const LONG_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
// Postgres: Key (gym_id, phone)=(…, 9876543210) already exists.
const PG_VALUES = /\)=\([^)]*\)/g;
// Double and curly quotes only: JavaScript's own errors use single quotes for property names
// ("reading 'name'"), which are useful and never personal.
const QUOTED = /"[^"\n]{1,200}"|“[^”\n]{1,200}”/g;

/** Text with personal data and secrets replaced. Keeps the rest readable. */
export function scrubText(value, { quotes = false } = {}) {
    if (value === null || value === undefined) return value;
    let text = String(value)
        .replace(JWT, "[token]")
        .replace(AUTH_HEADER, "$1 [token]")
        .replace(EMAIL, "[email]")
        .replace(PG_VALUES, ")=([removed])")
        .replace(LONG_TOKEN, "[token]")
        .replace(PHONE, "[phone]");
    if (quotes) text = text.replace(QUOTED, "[text]");
    return text;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A request path for logs: no query string, and ids, tokens, numbers and emails in its
 * segments replaced: /api/members/<uuid>/photo → /api/members/:id/photo, /c/<token> → /c/:token.
 */
export function maskPath(url) {
    const path = String(url || "").split(/[?#]/)[0] || "/";
    return path.split("/").map((segment) => {
        let decoded = segment;
        try { decoded = decodeURIComponent(segment); } catch { /* keep as sent */ }
        if (!decoded) return segment;
        if (UUID.test(decoded)) return ":id";
        if (decoded.includes("@")) return ":email";
        if (/^\+?\d{6,}$/.test(decoded.replace(/[\s-]/g, ""))) return ":number";
        if (/^[A-Za-z0-9_-]{20,}$/.test(decoded)) return ":token";
        return segment.length > 80 ? ":value" : segment;
    }).join("/");
}

/** Scrubs every string inside plain objects and arrays (a few levels deep). */
export function scrubValue(value, options = {}, depth = 0) {
    if (typeof value === "string") return scrubText(value, options);
    if (!value || typeof value !== "object" || depth > 6) return value;
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => scrubValue(item, options, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, scrubValue(item, options, depth + 1)]));
}
