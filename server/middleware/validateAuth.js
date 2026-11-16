import { z } from "zod";
import { clearRefreshCookie, readRefreshCookie } from "./sessionCookie.js";
import { passwordProblem } from "../../assets/js/passwordRules.js";

// remember = "Keep me signed in" (the default): the refresh cookie outlives the browser session.
const credentialsSchema = z.object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(256),
    remember: z.boolean().optional()
}).strict();
const gymSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();

function invalid(response, message) {
    return response.status(400).json({ status: "error", message });
}

export function validateCredentials(request, response, next) {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return invalid(response, "Enter a valid email address and password.");
    const { remember, ...credentials } = parsed.data;
    request.validatedCredentials = credentials;
    request.rememberSession = remember !== false;
    next();
}

// The refresh token comes only from the HttpOnly cookie, never from the request body.
export function validateRefreshToken(request, response, next) {
    const token = readRefreshCookie(request);
    if (!token) return response.status(401).json({ status: "error", message: "No saved session. Sign in again." });
    if (token.length < 20 || token.length > 4096) {
        clearRefreshCookie(request, response);
        return response.status(401).json({ status: "error", message: "Your session has expired. Sign in again." });
    }
    request.refreshToken = token;
    next();
}

export function validateGymName(request, response, next) {
    const parsed = gymSchema.safeParse(request.body);
    if (!parsed.success) return invalid(response, "Gym name must be between 1 and 120 characters.");
    request.gymName = parsed.data.name;
    next();
}

// ---------- Passwords ----------

const emailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict();

export function validateResetRequest(request, response, next) {
    const parsed = emailSchema.safeParse(request.body);
    if (!parsed.success) return invalid(response, "Enter the email address you sign in with.");
    request.resetEmail = parsed.data.email;
    next();
}

// The access token comes from the reset link (in the page address after "#", never sent to
// or logged by the server until this request), and lives only until the password is set.
const resetSchema = z.object({
    access_token: z.string().min(20).max(4096),
    password: z.string().max(512),
    confirm_password: z.string().max(512)
}).strict();

export function validatePasswordReset(request, response, next) {
    const parsed = resetSchema.safeParse(request.body);
    if (!parsed.success) return invalid(response, "Open the link in the reset email again, then choose a new password.");
    const problem = passwordProblem(parsed.data.password, parsed.data.confirm_password);
    if (problem) return invalid(response, problem);
    request.passwordReset = { accessToken: parsed.data.access_token, password: parsed.data.password };
    next();
}

const changeSchema = z.object({
    current_password: z.string().min(1).max(512),
    new_password: z.string().max(512),
    confirm_password: z.string().max(512)
}).strict();

export function validatePasswordChange(request, response, next) {
    const parsed = changeSchema.safeParse(request.body);
    if (!parsed.success) return invalid(response, "Enter your current password and the new password twice.");
    const problem = passwordProblem(parsed.data.new_password, parsed.data.confirm_password);
    if (problem) return invalid(response, problem);
    if (parsed.data.new_password === parsed.data.current_password) return invalid(response, "Choose a password that is different from your current one.");
    request.passwordChange = { currentPassword: parsed.data.current_password, newPassword: parsed.data.new_password };
    next();
}
