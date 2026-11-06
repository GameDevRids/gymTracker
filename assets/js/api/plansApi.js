import { apiClient } from "./apiClient.js";

export function fetchPlans(params = {}) {
    return apiClient.get("/api/plans", { params });
}

export async function fetchActivePlans() {
    const limit = 100;
    const plans = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
        const response = await fetchPlans({ page, limit, status: "active" });
        const pagePlans = response?.data?.plans;
        if (Array.isArray(pagePlans)) plans.push(...pagePlans.filter((plan) => plan.is_active));
        const total = response?.total ?? response?.data?.pagination?.total;
        totalPages = response?.data?.pagination?.totalPages
            ?? (Number.isFinite(total) ? Math.ceil(total / limit) : 1);
        page += 1;
    }

    return plans;
}
