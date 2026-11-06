import * as plansService from "../services/plansService.js";
import { logger } from "../config/logger.js";
import { captureException } from "../config/monitoring.js";

export function getPlans(request, response, next) {
    plansService.listPlans({ ...request.planListQuery, gymId: request.gymId })
        .then(({ plans, total }) => {
            const { page, limit } = request.planListQuery;
            response.json({
                status: "success",
                data: {
                    plans,
                    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
                },
                page,
                limit,
                total
            });
        })
        .catch(next);
}

export function getPlan(request, response, next) {
    plansService.getPlan(request.params.id, request.gymId)
        .then((plan) => response.json({ status: "success", data: plan }))
        .catch(next);
}

export function createPlan(request, response, next) {
    plansService.createPlan(request.validatedPlan, request.gymId)
        .then((plan) => response.status(201).json({ status: "success", data: plan }))
        .catch(next);
}

export function updatePlan(request, response, next) {
    plansService.updatePlan(request.params.id, request.validatedPlan, request.gymId)
        .then((plan) => response.json({ status: "success", data: plan }))
        .catch(next);
}

export function deletePlan(request, response, next) {
    plansService.deletePlan(request.params.id, request.gymId)
        .then(() => response.json({ status: "success", message: "Plan deleted successfully." }))
        .catch(next);
}

export function plansErrorHandler(error, _request, response, _next) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
        ? error.status
        : 500;
    if (status === 500) {
        logger.error({ err: error }, "Plans API request failed.");
        captureException(error);
    }
    response.status(status).json({
        status: "error",
        message: status === 500 ? "The server could not process this request." : error.message
    });
}
