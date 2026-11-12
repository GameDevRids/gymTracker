// Only the gym's owner may change how members check in (method, expired-member policy,
// location, poster link). Runs after requireAuth, which sets request.gymRole.
export function requireOwner(request, response, next) {
    if (request.gymRole !== "owner") {
        return response.status(403).json({ status: "error", message: "Only the gym owner can change check-in settings." });
    }
    next();
}
