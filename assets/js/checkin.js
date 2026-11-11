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
