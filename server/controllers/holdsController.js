import { cancelHold, listMemberHolds, resumeHold, startHold } from "../services/holdsService.js";

// Plan holds. The gym and the staff member come from the sign-in, never from the request body.
// The services are parameters so tests can supply a fake database.
export function createHoldHandlers(services = { cancelHold, listMemberHolds, resumeHold, startHold }) {
    const context = (request) => ({ gymId: request.gymId, userId: request.authUser?.id || null });
    const send = (response, status, data) => {
        response.set("Cache-Control", "no-store");
        response.status(status).json({ status: "success", data });
    };
    return {
        getHolds(request, response, next) {
            services.listMemberHolds(request.params.id, request.gymId).then((data) => send(response, 200, data)).catch(next);
        },
        postHold(request, response, next) {
            services.startHold(request.params.id, request.holdPayload, context(request))
                .then((result) => send(response, result.replayed ? 200 : 201, result)).catch(next);
        },
        postResume(request, response, next) {
            services.resumeHold(request.params.id, request.params.holdId, { ...context(request), reason: "resumed" })
                .then((result) => send(response, 200, result)).catch(next);
        },
        postCancel(request, response, next) {
            services.cancelHold(request.params.id, request.params.holdId, context(request))
                .then((result) => send(response, 200, result)).catch(next);
        }
    };
}

export const { getHolds, postHold, postResume, postCancel } = createHoldHandlers();
