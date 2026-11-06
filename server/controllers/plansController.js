import * as plansService from "../services/plansService.js";

export function getPlans(request, response, next) {
    plansService.listPlans(request.planListQuery)
        .then(({ plans, total }) => {
            const { page, limit } = request.planListQuery;
            response.json({
                status: "success",
                data: {
                    plans,
                    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
                }
            });
        })
        .catch(next);
}

export function getPlan(request, response, next) {
    plansService.getPlan(request.params.id)
        .then((plan) => response.json({ status: "success", data: plan }))
        .catch(next);
}

export function createPlan(request, response, next) {
    plansService.createPlan(request.validatedPlan)
        .then((plan) => response.status(201).json({ status: "success", data: plan }))
        .catch(next);
}

export function updatePlan(request, response, next) {
    plansService.updatePlan(request.params.id, request.validatedPlan)
        .then((plan) => response.json({ status: "success", data: plan }))
        .catch(next);
}

export function deletePlan(request, response, next) {
    plansService.deletePlan(request.params.id)
        .then(() => response.json({ status: "success", message: "Plan deleted successfully." }))
        .catch(next);
}

export function plansErrorHandler(error, _request, response, _next) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
        ? error.status
        : 500;
    if (status === 500) console.error("Plans API request failed.");
    response.status(status).json({
        status: "error",
        message: status === 500 ? "The server could not process this request." : error.message
    });
}
