import * as authService from "../services/authService.js";
import { clearRefreshCookie, publicSession, readRefreshCookie, setRefreshCookie } from "../middleware/sessionCookie.js";

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

    return { postLogin, postRefresh, postLogout, postCreateGym };
}

export const { postLogin, postRefresh, postLogout, postCreateGym } = createAuthHandlers();

export function authErrorHandler(error, _request, response, _next) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    response.status(status).json({
        status: "error",
        message: status === 500 ? "The authentication request could not be completed." : error.message
    });
}
