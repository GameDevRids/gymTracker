import { apiClient } from "./apiClient.js";

export async function fetchMemberMembershipHistory(memberId) {
    const response = await apiClient.get(`/api/members/${memberId}/memberships`);
    return Array.isArray(response?.data) ? response.data : [];
}

export function fetchMemberships(params = {}) {
    return apiClient.get("/api/memberships", { params });
}

export async function createMemberPlanAssignment(memberId, planId, startDate) {
    const response = await apiClient.post(`/api/members/${memberId}/memberships`, {
        plan_id: planId,
        start_date: startDate
    });
    return response?.data || null;
}
