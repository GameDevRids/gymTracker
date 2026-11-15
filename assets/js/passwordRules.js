// Password rules for setting or changing a password, shared by the browser and the server.
// No DOM imports, so the server validates with the same rules.

export const PASSWORD_MIN_LENGTH = 8;
// Supabase Auth stores passwords with bcrypt, which only uses the first 72 bytes.
export const PASSWORD_MAX_BYTES = 72;

/** "" when the new password can be used, otherwise what to fix. */
export function passwordProblem(password, confirmation = password) {
    const value = String(password ?? "");
    if (value.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters for the new password.`;
    if (new TextEncoder().encode(value).length > PASSWORD_MAX_BYTES) return "Use a shorter password (up to 72 letters or digits).";
    if (!/\S/.test(value) || value.trim() !== value) return "The password cannot start or end with a space.";
    if (value !== String(confirmation ?? "")) return "The two new passwords are not the same.";
    return "";
}

/**
 * Reads the link in a password-reset email after Supabase sends the browser back to
 * /reset-password: either #access_token=…&type=recovery, or an error such as an expired link.
 */
export function readRecoveryLink(hash = "", search = "") {
    const params = new URLSearchParams(String(hash).replace(/^#/, ""));
    const query = new URLSearchParams(String(search).replace(/^\?/, ""));
    const errorCode = params.get("error_code") || query.get("error_code") || params.get("error") || query.get("error") || "";
    if (errorCode) {
        const expired = /expired|otp|invalid|access_denied/i.test(`${errorCode} ${params.get("error_description") || query.get("error_description") || ""}`);
        return { accessToken: "", error: expired ? "expired" : "failed" };
    }
    const accessToken = params.get("access_token") || "";
    if (accessToken && (params.get("type") || "recovery") === "recovery") return { accessToken, error: "" };
    return { accessToken: "", error: "missing" };
}
