import { renewMember } from "../services/renewalsService.js";

/**
 * POST /api/members/:id/renew. 201 for a new renewal, 200 when the same key was already saved
 * (a retry). The gym and the staff member come from the sign-in, never from the request body.
 * The service is a parameter so tests can supply a fake database.
 */
export function createRenewHandler(renew = renewMember) {
    return function postRenew(request, response, next) {
        renew(request.params.id, request.renewalPayload, { gymId: request.gymId, userId: request.authUser?.id || null })
            .then((result) => {
                response.set("Cache-Control", "no-store");
                response.status(result.replayed ? 200 : 201).json({ status: "success", data: result });
            })
            .catch(next);
    };
}

export const postRenew = createRenewHandler();
