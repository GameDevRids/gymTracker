import { apiClient } from "./apiClient.js";

export async function fetchMemberPayments(memberId) {
    const response = await apiClient.get(`/api/payments/member/${memberId}`);
    return Array.isArray(response?.data) ? response.data : [];
}

export async function createPayment(payment) {
    const response = await apiClient.post("/api/payments", payment);
    return response?.data || null;
}
