import * as paymentsService from "../services/paymentsService.js";
import { captureException } from "../config/monitoring.js";
import { logger } from "../config/logger.js";

// data is the payment; balance_due is what is still due on its plan; replayed: this key was already saved.
export function postPayment(request, response, next) {
    paymentsService.createPayment(request.validatedPayment, { gymId: request.gymId, userId: request.authUser?.id || null })
        .then(({ payment, balance_due: balanceDue, replayed }) => response.status(replayed ? 200 : 201).json({ status: "success", data: payment, balance_due: balanceDue, replayed }))
        .catch(next);
}

export function postVoidPayment(request, response, next) {
    paymentsService.voidPayment(request.params.id, request.voidReason, { gymId: request.gymId, userId: request.authUser?.id || null })
        .then(({ payment, balance_due: balanceDue }) => response.json({ status: "success", data: payment, balance_due: balanceDue }))
        .catch(next);
}

export function getMemberPayments(request, response, next) {
    paymentsService.listMemberPayments(request.params.memberId, request.gymId)
        .then((payments) => response.json({ status: "success", data: payments }))
        .catch(next);
}

export function getPayments(request, response, next) {
    paymentsService.listPayments(request.paymentListQuery, request.gymId)
        .then(({ payments, total, monthTotal }) => response.json({
            status: "success",
            data: { payments, month_total: monthTotal, pagination: { ...request.paymentListQuery, total, totalPages: Math.ceil(total / request.paymentListQuery.limit) } }
        }))
        .catch(next);
}

export function getReceipt(request, response, next) {
    paymentsService.getReceipt(request.params.id, request.gymId)
        .then((receipt) => response.json({ status: "success", data: receipt }))
        .catch(next);
}

export function paymentsErrorHandler(error, _request, response, _next) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) {
        logger.error({ err: error }, "Payments API request failed.");
        captureException(error);
    }
    response.status(status).json({
        status: "error",
        message: status === 500 ? "The server could not process this request." : error.message,
        ...(status !== 500 && error.reason ? { code: error.reason } : {}),
        ...(status !== 500 && error.extra ? error.extra : {})
    });
}
