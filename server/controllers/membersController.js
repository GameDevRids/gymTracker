import * as membersService from "../services/membersService.js";

export function getMembers(request, response, next) {
    membersService.listMembers(request.memberListQuery)
        .then(({ members, total }) => {
            const { page, limit } = request.memberListQuery;
            response.json({
                status: "success",
                data: {
                    members,
                    pagination: {
                        page,
                        limit,
                        total,
                        totalPages: Math.ceil(total / limit)
                    }
                }
            });
        })
        .catch(next);
}

export function getMember(request, response, next) {
    membersService.getMember(request.params.id)
        .then((member) => response.json({ status: "success", data: member }))
        .catch(next);
}

export function createMember(request, response, next) {
    membersService.createMember(request.validatedMember)
        .then((member) => response.status(201).json({ status: "success", data: member }))
        .catch(next);
}

export function updateMember(request, response, next) {
    membersService.updateMember(request.params.id, request.validatedMember)
        .then((member) => response.json({ status: "success", data: member }))
        .catch(next);
}

export function deleteMember(request, response, next) {
    membersService.deleteMember(request.params.id)
        .then(() => response.json({ status: "success", message: "Member deleted successfully." }))
        .catch(next);
}

export function membersErrorHandler(error, _request, response, _next) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
        ? error.status
        : 500;
    if (status === 500) console.error("Members API request failed.");
    response.status(status).json({
        status: "error",
        message: status === 500 ? "The server could not process this request." : error.message
    });
}
