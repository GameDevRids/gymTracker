// UPI payment links and checks. No DOM or storage access: shared by the browser and the server.
// GymPulse has no payment gateway; the member pays in any UPI app and staff confirm the payment.

// Same rule as the gym_settings_upi_id_format constraint in migration 011.
export const UPI_ID_PATTERN = /^[A-Za-z0-9._-]{2,200}@[A-Za-z][A-Za-z0-9.-]{1,63}$/;
export const UTR_PATTERN = /^[0-9]{12}$/;
// UPI apps show only a short note; longer text is cut by some of them.
export const UPI_NOTE_MAX_LENGTH = 50;

export function isValidUpiId(value) {
    return typeof value === "string" && UPI_ID_PATTERN.test(value);
}

/** "" for a usable UPI ID (or none), otherwise why it is rejected. */
export function upiIdProblem(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    if (/\s/.test(text)) return "A UPI ID has no spaces, for example powergym@okicici.";
    if (!isValidUpiId(text)) return "Enter a UPI ID like powergym@okicici: letters or numbers, then @, then the bank handle.";
    return "";
}

export function isValidUtr(value) {
    return typeof value === "string" && UTR_PATTERN.test(value);
}

export function formatUpiAmount(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Enter an amount greater than zero.");
    return (Math.round(value * 100) / 100).toFixed(2);
}

/** The note shown in the payer's app: gym name, member code, plan. */
export function upiNote({ gymName = "", memberCode = "", planName = "" } = {}) {
    const note = [gymName, memberCode, planName].map((part) => String(part || "").trim()).filter(Boolean).join(", ");
    return note.length > UPI_NOTE_MAX_LENGTH ? `${note.slice(0, UPI_NOTE_MAX_LENGTH - 1).trimEnd()}…` : note;
}

// Percent-encodes a value. "@" is left as is: it is allowed in a URL query, and some UPI apps
// do not decode "%40" in the payee address.
function encodeValue(value) {
    return encodeURIComponent(String(value)).replace(/%40/g, "@");
}

/**
 * upi://pay?pa=<upi id>&pn=<payee name>&am=<amount, 2 decimals>&cu=INR&tn=<note>
 * Throws when the UPI ID is missing or invalid, or the amount is not positive.
 */
export function buildUpiLink({ upiId, payeeName = "", amount, note = "" } = {}) {
    const address = String(upiId ?? "").trim();
    if (!address) throw new Error("Set the gym's UPI ID in Settings first.");
    if (!isValidUpiId(address)) throw new Error("The gym's UPI ID is not valid. Check it in Settings.");
    const params = [["pa", address]];
    if (String(payeeName).trim()) params.push(["pn", String(payeeName).trim()]);
    params.push(["am", formatUpiAmount(amount)], ["cu", "INR"]);
    if (String(note).trim()) params.push(["tn", String(note).trim()]);
    return `upi://pay?${params.map(([key, value]) => `${key}=${encodeValue(value)}`).join("&")}`;
}
