import { z } from "zod";

const credentialsSchema = z.object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(256)
}).strict();
const gymSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();

function invalid(response, message) {
    return response.status(400).json({ status: "error", message });
}

export function validateCredentials(request, response, next) {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return invalid(response, "Enter a valid email address and password.");
    request.validatedCredentials = parsed.data;
    next();
}

export function validateRefreshToken(request, response, next) {
    const token = request.body?.refresh_token;
    if (typeof token !== "string" || token.length < 20 || token.length > 4096) {
        return invalid(response, "A valid refresh token is required.");
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
