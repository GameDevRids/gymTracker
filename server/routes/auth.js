import express from "express";
import { authErrorHandler, createAuthHandlers } from "../controllers/authController.js";
import { requireAuth } from "../middleware/requireAuth.js";
import {
    validateCredentials,
    validateGymName,
    validatePasswordChange,
    validatePasswordReset,
    validateRefreshToken,
    validateResetRequest
} from "../middleware/validateAuth.js";
import { requireSameOrigin } from "../middleware/sessionCookie.js";
import { createLimit } from "../middleware/authRateLimit.js";

/** Builds the auth router; tests pass a fake service instead of the Supabase one. */
export function createAuthRouter(service) {
    const { postLogin, postRefresh, postLogout, postCreateGym, postForgotPassword, postResetPassword, postChangePassword } = createAuthHandlers(service);
    const router = express.Router();
    // Reset emails are few per IP (each one lands in someone's inbox); password changes and new
    // passwords share the sign-in limit's size.
    const forgotLimit = createLimit(5, "Too many reset requests. Please wait 15 minutes and try again.");
    const passwordLimit = createLimit(10, "Too many attempts. Please wait 15 minutes and try again.");

    // Login, refresh and logout use the refresh-token cookie, so they only accept same-origin browser requests.
    router.post("/login", requireSameOrigin, validateCredentials, postLogin);
    router.post("/refresh", requireSameOrigin, validateRefreshToken, postRefresh);
    router.post("/logout", requireSameOrigin, postLogout);
    router.post("/gym", requireAuth({ allowNoGym: true }), validateGymName, postCreateGym);
    router.post("/forgot-password", requireSameOrigin, forgotLimit, validateResetRequest, postForgotPassword);
    router.post("/reset-password", requireSameOrigin, passwordLimit, validatePasswordReset, postResetPassword);
    router.post("/change-password", requireSameOrigin, passwordLimit, requireAuth({ allowNoGym: true }), validatePasswordChange, postChangePassword);
    router.use(authErrorHandler);
    return router;
}

export default createAuthRouter();
