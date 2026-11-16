import * as membershipsService from "../services/membershipsService.js";
import { listExpiring, listLapsed } from "../services/memberStatusService.js";
import { expiryRemindersFor } from "../services/whatsappMessagesService.js";
import { logger } from "../config/logger.js";
import { captureException } from "../config/monitoring.js";

export function getMemberMemberships(request, response, next) {
    membershipsService.listMemberMemberships(request.params.memberId, request.gymId)
        .then((memberships) => response.json({ status: "success", data: memberships }))
        .catch(next);
}

export function assignMemberPlan(request, response, next) {
    membershipsService.assignMemberPlan(request.params.memberId, request.validatedAssignment, request.gymId)
        .then((membership) => response.status(201).json({ status: "success", data: membership }))
        .catch(next);
}

export function getMembership(request, response, next) {
    membershipsService.getMembership(request.params.id, request.gymId)
        .then((membership) => response.json({ status: "success", data: membership }))
        .catch(next);
}

export function getMemberships(request, response, next) {
    membershipsService.listMemberships({ ...request.membershipListQuery, gymId: request.gymId })
        .then(({ memberships, total }) => {
            const { page, limit } = request.membershipListQuery;
            response.json({
                status: "success",
                data: {
                    memberships,
                    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
                },
                page,
                limit,
                total
            });
        })
        .catch(next);
}

// Expiring soon: members whose plan ends within 7 days, and members in grace (shared status rule).
// Each row carries reminded_at: when its current end date was last reminded about, or null.
export function getExpiringMemberships(request, response, next) {
    listExpiring(request.gymId)
        .then(async (memberships) => {
            const reminded = await expiryRemindersFor(memberships, request.gymId);
            response.set("Cache-Control", "no-store");
            response.json({
                status: "success",
                data: memberships.map((membership) => ({ ...membership, reminded_at: reminded.get(membership.id) || null }))
            });
        })
        .catch(next);
}

// Lapsed members (?list=lapsed, the default) or old members (?list=old), most recently ended first.
export function getLapsedMembers(request, response, next) {
    const list = request.query.list === undefined ? "lapsed" : request.query.list;
    if (!["lapsed", "old"].includes(list)) return response.status(400).json({ status: "error", message: "list must be lapsed or old." });
    listLapsed(request.gymId, list)
        .then((rows) => {
            response.set("Cache-Control", "no-store");
            response.json({ status: "success", data: rows });
        })
        .catch(next);
}

export function membershipsErrorHandler(error, _request, response, _next) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
        ? error.status
        : 500;
    if (status === 500) {
        logger.error({ err: error }, "Membership API request failed.");
        captureException(error);
    }
    response.status(status).json({
        status: "error",
        message: status === 500 ? "The server could not process this request." : error.message
    });
}
