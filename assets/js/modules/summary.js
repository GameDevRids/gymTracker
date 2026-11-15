// Gym-wide totals for the Overview, Analytics and Payments pages. Real gyms read them from the
// database (GET /api/summary, migration 015), so they cover every member and payment.
import { apiClient } from "../api/apiClient.js";

// { status: "idle" | "loading" | "ready" | "error", data, message }
export const gymSummary = { status: "idle", data: null, message: "" };
let request;

export function loadSummary(onChange = () => {}) {
    if (request) return request.then(() => { onChange(); return gymSummary; });
    if (gymSummary.status !== "ready") gymSummary.status = "loading";
    request = apiClient.get("/api/summary", { params: { months: 6 } })
        .then((response) => {
            gymSummary.data = response?.data || null;
            gymSummary.status = gymSummary.data ? "ready" : "error";
            gymSummary.message = gymSummary.data ? "" : "Gym totals could not be loaded.";
        })
        .catch((error) => {
            gymSummary.status = "error";
            gymSummary.message = error.message || "Gym totals could not be loaded.";
        })
        .finally(() => {
            request = undefined;
            onChange();
        });
    return request.then(() => gymSummary);
}

/** { status, data, message } for the current workspace. */
export function currentSummary() {
    return gymSummary;
}

/** "Nov" for "2026-11". */
export function monthLabel(month) {
    const [year, index] = String(month).split("-").map(Number);
    return new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, index - 1, 1)));
}
