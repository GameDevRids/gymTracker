import { apiClient } from "./apiClient.js";

export async function fetchMemberPayments(memberId) {
    const response = await apiClient.get(`/api/payments/member/${memberId}`);
    return Array.isArray(response?.data) ? response.data : [];
}

/**
 * Saves a payment (migration 025). payment.idempotency_key: one per opened form, so a retry
 * returns the first payment. Returns { payment, balanceDue, replayed }. A refusal throws with
 * error.code ("fully_paid", "over_balance", …) and error.details.balance_due.
 */
export async function createPayment(payment) {
    const response = await apiClient.post("/api/payments", payment);
    return { payment: response?.data || null, balanceDue: response?.balance_due ?? null, replayed: response?.replayed === true };
}

/** Voids a payment (owner only) with a reason. Returns { payment, balanceDue }. */
export async function voidPayment(paymentId, reason) {
    const response = await apiClient.post(`/api/payments/${paymentId}/void`, { reason });
    return { payment: response?.data || null, balanceDue: response?.balance_due ?? null };
}
