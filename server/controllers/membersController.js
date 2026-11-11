import * as membersService from "../services/membersService.js";
import { logger } from "../config/logger.js";
import { captureException } from "../config/monitoring.js";

export function getMembers(request, response, next) {
    membersService.listMembers({ ...request.memberListQuery, gymId: request.gymId })
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
                },
                page,
                limit,
                total
            });
        })
        .catch(next);
}

export function getMember(request, response, next) {
    membersService.getMember(request.params.id, request.gymId)
        .then((member) => response.json({ status: "success", data: member }))
        .catch(next);
}

export function createMember(request, response, next) {
    membersService.createMember(request.validatedMember, request.gymId)
        .then((member) => response.status(201).json({ status: "success", data: member }))
        .catch(next);
}

export function updateMember(request, response, next) {
    membersService.updateMember(request.params.id, request.validatedMember, request.gymId)
        .then((member) => response.json({ status: "success", data: member }))
        .catch(next);
}

export function setWhatsAppConsent(request, response, next) {
    membersService.setWhatsAppConsent(request.params.id, {
        ...request.validatedConsent,
        recordedBy: request.authUser?.id || null
    }, request.gymId)
        .then((member) => response.json({ status: "success", data: member }))
        .catch(next);
}

export function getConsentEvents(request, response, next) {
    membersService.listConsentEvents(request.params.id, request.gymId)
        .then((events) => response.json({ status: "success", data: events }))
        .catch(next);
}

export function deleteMember(request, response, next) {
    membersService.deleteMember(request.params.id, request.gymId)
        .then(() => response.json({ status: "success", message: "Member deleted successfully." }))
        .catch(next);
}

export function membersErrorHandler(error, _request, response, _next) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
        ? error.status
        : 500;
    if (status === 500) {
        logger.error({ err: error }, "Members API request failed.");
        captureException(error);
    }
    response.status(status).json({
        status: "error",
        message: status === 500 ? "The server could not process this request." : error.message
    });
}
