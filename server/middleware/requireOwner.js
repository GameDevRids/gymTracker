// Things only the gym's owner may do. Runs after requireAuth, which sets request.gymRole.
export function ownerOnly(message = "Only the gym owner can do this.") {
    return (request, response, next) => {
        if (request.gymRole !== "owner") return response.status(403).json({ status: "error", message });
        next();
    };
}

// How members check in (method, expired-member policy, location, poster link).
export const requireOwner = ownerOnly("Only the gym owner can change check-in settings.");
