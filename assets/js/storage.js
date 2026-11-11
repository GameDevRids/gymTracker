import { createEmptyState, removeLegacyDemoData } from "../../data/demo-data.js";

let storageKey = "gympulse.prototype.v1";

export function setStorageUser(userId) {
    storageKey = userId ? `gympulse.owner.${encodeURIComponent(userId)}.v1` : "gympulse.prototype.v1";
}

export function loadState() {
    try {
        const saved = localStorage.getItem(storageKey);
        if (!saved) {
            const initial = createEmptyState();
            saveState(initial);
            return initial;
        }
        const state = JSON.parse(saved);
        if (!state || !Array.isArray(state.members) || !Array.isArray(state.plans)) throw new Error("Saved GymPulse data is not valid.");
        const { state: cleaned, changed } = removeLegacyDemoData(state);
        if (changed) saveState(cleaned);
        return cleaned;
    } catch (error) {
        if (error instanceof SyntaxError) throw new Error("Saved GymPulse data could not be read. Use Settings → Clear local sample data to restore an empty workspace.");
        if (error instanceof DOMException && error.name === "SecurityError") throw new Error("Browser storage is blocked. Enable local storage to use GymPulse.");
        throw error;
    }
}

export function saveState(state) {
    try {
        localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (error) {
        if (error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "SecurityError")) {
            throw new Error("GymPulse could not save to browser storage. Check browser storage permissions and available space.");
        }
        throw error;
    }
}

export function resetState() {
    const state = createEmptyState();
    saveState(state);
    return state;
}
