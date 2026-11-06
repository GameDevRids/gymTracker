import * as authService from "../services/authService.js";

export function postLogin(request, response, next) {
    authService.login(request.validatedCredentials)
        .then((session) => response.json({ status: "success", data: session }))
        .catch(next);
}

export function postRefresh(request, response, next) {
    authService.refresh(request.refreshToken)
        .then((session) => response.json({ status: "success", data: session }))
        .catch(next);
}

export function postLogout(request, response, next) {
    const accessToken = /^Bearer\s+([^\s]+)$/i.exec(request.get("Authorization") || "")?.[1];
    if (!accessToken) return response.status(401).json({ status: "error", message: "Authentication required." });
    authService.logout(accessToken)
        .then(() => response.json({ status: "success" }))
        .catch(next);
}

export function postCreateGym(request, response, next) {
    authService.createGym(request.gymName, request.authUser.id)
        .then((gym) => response.status(201).json({ status: "success", data: { gym } }))
        .catch(next);
}

export function authErrorHandler(error, _request, response, _next) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    response.status(status).json({
        status: "error",
        message: status === 500 ? "The authentication request could not be completed." : error.message
    });
}
