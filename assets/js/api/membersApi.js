import { apiClient } from "./apiClient.js";

export function fetchMembers(params = {}) {
    return apiClient.get("/api/members", { params });
}
