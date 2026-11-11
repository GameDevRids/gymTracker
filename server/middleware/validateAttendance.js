import { z } from "zod";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});

function invalid(response, message) {
    return response.status(400).json({ status: "error", message });
}

export function validateScan(request, response, next) {
    const parsed = z.object({ token: z.string().max(200) }).strict().safeParse(request.body);
    if (!parsed.success) return invalid(response, "Send the scanned token as { token }.");
    request.scanToken = parsed.data.token.trim();
    next();
}

export function validateManualCheckIn(request, response, next) {
    const parsed = z.object({ member_id: uuid }).strict().safeParse(request.body);
    if (!parsed.success) return invalid(response, "Choose a member to check in.");
    request.checkInMemberId = parsed.data.member_id;
    next();
}

export function validateAttendanceQuery(request, response, next) {
    const parsed = z.object({ date: day.optional(), from: day.optional(), to: day.optional() }).strict().safeParse(request.query);
    if (!parsed.success) return invalid(response, "Dates must be YYYY-MM-DD; use date, or from and to.");
    const { date, from, to } = parsed.data;
    if (!date && !from) return invalid(response, "Give a date, or a from date.");
    if (from && to && from > to) return invalid(response, "The from date must be on or before the to date.");
    if (from && (Date.parse(to || from) - Date.parse(from)) / 86400000 > 400) return invalid(response, "Ask for at most 400 days at a time.");
    request.attendanceQuery = parsed.data;
    next();
}

const importSchema = z.object({
    records: z.array(z.object({
        member_id: uuid,
        checked_in_at: z.string().datetime({ offset: true }),
        method: z.string().max(20).optional()
    })).min(1).max(5000)
}).strict();

export function validateAttendanceImport(request, response, next) {
    const parsed = importSchema.safeParse(request.body);
    if (!parsed.success) return invalid(response, "Send up to 5000 records, each with member_id and checked_in_at.");
    request.importRecords = parsed.data.records;
    next();
}

// Per signed-in user (each scanner device logs in), not per IP: every device on the gym's
// Wi-Fi shares one IP. A busy entrance manages far fewer than 60 scans a minute per device.
export const SCAN_RATE_LIMIT = { windowMs: 60 * 1000, limit: 60 };

export function createScanRateLimit(options = SCAN_RATE_LIMIT) {
    return rateLimit({
        ...options,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (request) => request.authUser?.id ? `user:${request.authUser.id}` : ipKeyGenerator(request.ip || ""),
        message: { status: "error", message: "Too many scans in a minute. Wait a moment and try again." }
    });
}
