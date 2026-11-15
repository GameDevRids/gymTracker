import * as authService from "../services/authService.js";
import { clearRefreshCookie, publicSession, readRefreshCookie, setRefreshCookie } from "../middleware/sessionCookie.js";
import { logger } from "../config/logger.js";
import { captureException } from "../config/monitoring.js";

// Login and refresh put the refresh token in an HttpOnly cookie and return only the access token.
function sendSession(request, response, session) {
    if (session.refresh_token) setRefreshCookie(request, response, session.refresh_token);
    response.json({ status: "success", data: publicSession(session) });
}

/** Builds the auth handlers around a service, so tests can supply a fake Supabase service. */
export function createAuthHandlers(service = authService) {
    function postLogin(request, response, next) {
        service.login(request.validatedCredentials)
            .then((session) => sendSession(request, response, session))
            .catch(next);
    }

    function postRefresh(request, response, next) {
        service.refresh(request.refreshToken)
            .then((session) => sendSession(request, response, session))
            .catch((error) => {
                // A rejected refresh token will never work again, so stop the browser sending it.
                if (error?.status === 401) clearRefreshCookie(request, response);
                next(error);
            });
    }

    // Always clears the refresh cookie, then revokes the session with Supabase. The access
    // token may have expired, so the refresh cookie is used to revoke when the token cannot be.
    async function postLogout(request, response, next) {
        const bearerToken = /^Bearer\s+([^\s]+)$/i.exec(request.get("Authorization") || "")?.[1];
        const refreshToken = readRefreshCookie(request);
        clearRefreshCookie(request, response);
        try {
            if (bearerToken) {
                try {
                    await service.logout(bearerToken);
                    return response.json({ status: "success" });
                } catch (error) {
                    if (!refreshToken) throw error;
                }
            }
            if (refreshToken) {
                let session = null;
                try {
                    session = await service.refresh(refreshToken);
                } catch (error) {
                    // 401 means the refresh token is already invalid, so there is nothing left to revoke.
                    if (error?.status !== 401) throw error;
                }
                if (session?.access_token) await service.logout(session.access_token);
            }
            return response.json({ status: "success" });
        } catch (error) {
            return next(error);
        }
    }

    function postCreateGym(request, response, next) {
        service.createGym(request.gymName, request.authUser.id)
            .then((gym) => response.status(201).json({ status: "success", data: { gym } }))
            .catch(next);
    }

    // The same answer whether or not the email has an account.
    function postForgotPassword(request, response, next) {
        service.requestPasswordReset(request.resetEmail, resetPageUrl(request))
            .then(() => response.json({ status: "success", message: "If an account uses that email, a link to choose a new password is on its way. Check your inbox and spam folder; the link works for one hour." }))
            .catch(next);
    }

    // Every device is signed out after a reset, so this browser's refresh cookie goes too.
    function postResetPassword(request, response, next) {
        service.resetPassword(request.passwordReset.accessToken, request.passwordReset.password)
            .then(() => {
                clearRefreshCookie(request, response);
                response.json({ status: "success", message: "Your password was changed. Sign in with the new password." });
            })
            .catch(next);
    }

    function postChangePassword(request, response, next) {
        service.changePassword(request.authUser.email, request.passwordChange.currentPassword, request.passwordChange.newPassword)
            .then((session) => sendSession(request, response, session))
            .catch(next);
    }

    return { postLogin, postRefresh, postLogout, postCreateGym, postForgotPassword, postResetPassword, postChangePassword };
}

/**
 * Where the reset email's link opens: PUBLIC_APP_URL (set it on Render) or this request's own
 * address. Supabase only uses addresses on its Redirect URLs list, so a forged Host header
 * cannot send the link elsewhere.
 */
export function resetPageUrl(request, environment = process.env) {
    const configured = String(environment.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
    const base = /^https?:\/\//i.test(configured) ? configured : `${request.protocol}://${request.get("host")}`;
    return `${base}/reset-password`;
}

export const { postLogin, postRefresh, postLogout, postCreateGym } = createAuthHandlers();

export function authErrorHandler(error, _request, response, _next) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) {
        logger.error({ err: error }, "Authentication request failed.");
        captureException(error);
    }
    response.status(status).json({
        status: "error",
        message: status === 500 ? "The authentication request could not be completed." : error.message
    });
}
