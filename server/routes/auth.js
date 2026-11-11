import express from "express";
import { authErrorHandler, createAuthHandlers } from "../controllers/authController.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { validateCredentials, validateGymName, validateRefreshToken } from "../middleware/validateAuth.js";
import { requireSameOrigin } from "../middleware/sessionCookie.js";

/** Builds the auth router; tests pass a fake service instead of the Supabase one. */
export function createAuthRouter(service) {
    const { postLogin, postRefresh, postLogout, postCreateGym } = createAuthHandlers(service);
    const router = express.Router();

    // Login, refresh and logout use the refresh-token cookie, so they only accept same-origin browser requests.
    router.post("/login", requireSameOrigin, validateCredentials, postLogin);
    router.post("/refresh", requireSameOrigin, validateRefreshToken, postRefresh);
    router.post("/logout", requireSameOrigin, postLogout);
    router.post("/gym", requireAuth({ allowNoGym: true }), validateGymName, postCreateGym);
    router.use(authErrorHandler);
    return router;
}

export default createAuthRouter();
