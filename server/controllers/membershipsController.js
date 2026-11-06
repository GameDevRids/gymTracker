import * as membershipsService from "../services/membershipsService.js";

export function getMemberMemberships(request, response, next) {
    membershipsService.listMemberMemberships(request.params.memberId)
        .then((memberships) => response.json({ status: "success", data: memberships }))
        .catch(next);
}

export function assignMemberPlan(request, response, next) {
    membershipsService.assignMemberPlan(request.params.memberId, request.validatedAssignment)
        .then((membership) => response.status(201).json({ status: "success", data: membership }))
        .catch(next);
}

export function getMembership(request, response, next) {
    membershipsService.getMembership(request.params.id)
        .then((membership) => response.json({ status: "success", data: membership }))
        .catch(next);
}

export function getMemberships(request, response, next) {
    membershipsService.listMemberships(request.membershipListQuery)
        .then(({ memberships, total }) => {
            const { page, limit } = request.membershipListQuery;
            response.json({
                status: "success",
                data: {
                    memberships,
                    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
                }
            });
        })
        .catch(next);
}

export function membershipsErrorHandler(error, _request, response, _next) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
        ? error.status
        : 500;
    if (status === 500) console.error("Membership API request failed.");
    response.status(status).json({
        status: "error",
        message: status === 500 ? "The server could not process this request." : error.message
    });
}
