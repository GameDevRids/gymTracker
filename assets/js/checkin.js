// What a member's check-in QR contains. No DOM or storage access: shared with the server tests.
// The token is random and says nothing about the member; it only works inside the gym's
// own signed-in scanner.

export const CHECKIN_PREFIX = "gympulse:checkin:";
export const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

export function memberQrText(token) {
    if (!QR_TOKEN_PATTERN.test(String(token || ""))) throw new Error("This member has no check-in QR yet.");
    return `${CHECKIN_PREFIX}${token}`;
}

/** The token from a scanned QR, or null when the QR is not a GymPulse check-in code. */
export function parseCheckinQr(text) {
    const value = String(text ?? "").trim();
    if (!value.startsWith(CHECKIN_PREFIX)) return null;
    const token = value.slice(CHECKIN_PREFIX.length);
    return QR_TOKEN_PATTERN.test(token) ? token : null;
}

/** Whole days from today (IST) until the end date; negative once it has passed. */
export function daysLeft(endDate, today) {
    if (!endDate || !today) return null;
    return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

export function indiaDate(date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// ---------- Check-in methods and the expired-member policy (shared with the server) ----------

export const CHECKIN_METHODS = ["member_qr", "entrance_poster"];
export const EXPIRED_POLICIES = ["warn", "block"];
export const MAX_GRACE_DAYS = 60;

/** The first word of a name: the poster page never shows more than this. */
export function firstName(fullName) {
    return String(fullName || "").trim().split(/\s+/)[0] || "";
}

/** A 10-digit Indian mobile number from "+91 98765 43210", "098765 43210" and so on, or null. */
export function normalizeIndianMobile(value) {
    let digits = String(value ?? "").replace(/[\s()+-]/g, "");
    if (!/^\d+$/.test(digits)) return null;
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** Great-circle distance in metres. */
export function distanceMeters(lat1, lon1, lat2, lon2) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const a = Math.sin(radians(lat2 - lat1) / 2) ** 2
        + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lon2 - lon1) / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// GPS on phones is often off by tens of metres indoors; at most this much of the reported
// accuracy is added to the radius, so a vague fix cannot stretch it far.
export const MAX_ACCURACY_ALLOWANCE_M = 50;

/** Whether a reported position is close enough to the gym. */
export function withinRadius(gym, position) {
    const distance = distanceMeters(gym.latitude, gym.longitude, position.latitude, position.longitude);
    const allowance = Math.min(Math.max(Number(position.accuracy) || 0, 0), MAX_ACCURACY_ALLOWANCE_M);
    return { ok: distance <= gym.location_radius_m + allowance, distance: Math.round(distance) };
}

/**
 * The membership status at check-in: active, grace (expired, inside the gym's grace days),
 * upcoming (plan starts later), expired, or none. `membership` carries effective_status.
 */
export function checkInStatus(membership, today, graceDays = 0) {
    if (!membership) return { status: "none" };
    if (membership.effective_status === "active") return { status: "active" };
    if (membership.effective_status === "upcoming") return { status: "upcoming" };
    if (membership.effective_status === "expired") {
        const daysExpired = -daysLeft(membership.end_date, today);
        if (daysExpired <= graceDays) return { status: "grace", graceDaysLeft: graceDays - daysExpired };
        return { status: "expired" };
    }
    return { status: "none" };
}

const RESULT_FOR_STATUS = { active: "checked_in", grace: "grace", upcoming: "upcoming", expired: "expired", none: "no_membership" };

/**
 * What happens to a check-in with this status. Active and grace are always recorded; the others
 * are recorded and flagged under "warn", and not recorded under "block".
 */
export function checkInOutcome(status, policy = "warn") {
    const allowed = status === "active" || status === "grace" || policy !== "block";
    return { result: RESULT_FOR_STATUS[status] || "no_membership", recorded: allowed, blocked: !allowed };
}
