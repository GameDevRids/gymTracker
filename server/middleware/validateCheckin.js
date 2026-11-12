import { z } from "zod";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { CHECKIN_METHODS, EXPIRED_POLICIES, MAX_GRACE_DAYS } from "../../assets/js/checkin.js";
import { DEVICE_SECRET_PATTERN, hashDeviceSecret } from "../services/entranceService.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

function invalid(response, message) {
    return response.status(400).json({ status: "error", message });
}

// ---------- Settings > Attendance (owner only) ----------

const settingsSchema = z.object({
    checkin_method: z.enum(CHECKIN_METHODS),
    expired_checkin_policy: z.enum(EXPIRED_POLICIES),
    expiry_grace_days: z.number().int().min(0).max(MAX_GRACE_DAYS),
    entrance_require_location: z.boolean(),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    location_radius_m: z.number().int().min(25).max(2000)
}).partial().strict();

export function validateCheckinSettings(request, response, next) {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        const messages = {
            checkin_method: "Choose member QR cards or the entrance poster.",
            expired_checkin_policy: "Choose Allow with warning or Block check-in.",
            expiry_grace_days: `Grace period must be 0 to ${MAX_GRACE_DAYS} days.`,
            location_radius_m: "The radius must be 25 to 2000 metres.",
            latitude: "The location is not valid.",
            longitude: "The location is not valid."
        };
        return invalid(response, messages[field] || "Send only the check-in settings.");
    }
    const values = parsed.data;
    if ((values.latitude === null) !== (values.longitude === null) || ("latitude" in values) !== ("longitude" in values)) {
        return invalid(response, "Send the latitude and longitude together.");
    }
    if (!Object.keys(values).length) return invalid(response, "Nothing to change.");
    request.checkinSettings = values;
    next();
}

// ---------- Staff: manual search and phone approvals ----------

export function validateCheckinSearch(request, response, next) {
    const parsed = z.object({ q: z.string().max(80).optional() }).strict().safeParse(request.query);
    if (!parsed.success) return invalid(response, "Search with ?q= (up to 80 characters).");
    request.checkinSearch = parsed.data.q || "";
    next();
}

export function validateDeviceId(request, response, next) {
    if (!uuid.safeParse(request.params.id).success) return invalid(response, "Unknown phone link.");
    next();
}

// ---------- The public poster page ----------

const linkSchema = z.object({ phone: z.string().max(20) }).strict();
const checkinSchema = z.object({
    member: uuid.optional(),
    location: z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracy: z.number().min(0).max(100000).optional()
    }).strict().optional()
}).strict();

export function validateLinkRequest(request, response, next) {
    const parsed = linkSchema.safeParse(request.body);
    if (!parsed.success) return invalid(response, "Enter your 10-digit mobile number.");
    request.linkPhone = parsed.data.phone;
    next();
}

export function validateEntranceCheckIn(request, response, next) {
    const parsed = checkinSchema.safeParse(request.body || {});
    if (!parsed.success) return invalid(response, "The check-in request is not valid. Reload the page.");
    request.entranceCheckIn = parsed.data;
    next();
}

// Limits for the public page. Gym Wi-Fi and mobile carriers put many people behind one IP,
// so the per-IP limits are loose; the per-poster, per-phone and per-number limits are strict.
export const ENTRANCE_LIMITS = {
    pageIp: { windowMs: 15 * 60 * 1000, limit: 120 },
    linkIp: { windowMs: 15 * 60 * 1000, limit: 20 },
    linkPoster: { windowMs: 15 * 60 * 1000, limit: 100 },
    checkinIp: { windowMs: 15 * 60 * 1000, limit: 120 },
    checkinPhone: { windowMs: 60 * 1000, limit: 10 }
};

const ipKey = (request) => ipKeyGenerator(request.ip || "");

function limiter(options, keyGenerator, message) {
    return rateLimit({
        ...options,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator,
        message: { status: "error", message }
    });
}

export function createEntranceLimits(limits = ENTRANCE_LIMITS) {
    const busy = "Too many tries. Please wait a few minutes and try again.";
    return {
        page: limiter(limits.pageIp, ipKey, busy),
        linkIp: limiter(limits.linkIp, ipKey, busy),
        linkPoster: limiter(limits.linkPoster, (request) => `poster:${request.params.token}`, busy),
        checkinIp: limiter(limits.checkinIp, ipKey, busy),
        // Keyed by the phone's secret (hashed); phones without one share the IP's allowance.
        checkinPhone: limiter(limits.checkinPhone, (request) => {
            const secret = request.deviceSecret;
            return DEVICE_SECRET_PATTERN.test(String(secret || "")) ? `phone:${hashDeviceSecret(secret)}` : `ip:${ipKey(request)}`;
        }, busy)
    };
}

/**
 * Locks a mobile number for 15 minutes after 5 attempts. Counted for every number, member or
 * not, so the lock itself says nothing about who is a member. Kept in memory: one instance.
 */
export function createNumberLockout({ attempts = 5, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000 } = {}) {
    const entries = new Map();
    function prune(now) {
        if (entries.size < 5000) return;
        for (const [key, entry] of entries) {
            if (entry.lockedUntil <= now && now - entry.firstAt > windowMs) entries.delete(key);
        }
    }
    return {
        /** Counts an attempt; returns false when the number is locked. */
        attempt(number, now = Date.now()) {
            prune(now);
            const key = String(number);
            let entry = entries.get(key);
            if (entry?.lockedUntil > now) return false;
            if (!entry || now - entry.firstAt > windowMs || entry.lockedUntil) entry = { count: 0, firstAt: now, lockedUntil: 0 };
            entry.count += 1;
            if (entry.count >= attempts) entry.lockedUntil = now + lockMs;
            entries.set(key, entry);
            return true;
        },
        isLocked(number, now = Date.now()) {
            return (entries.get(String(number))?.lockedUntil || 0) > now;
        }
    };
}
