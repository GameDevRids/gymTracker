// Browser storage. Gym data lives in the database; the browser keeps only:
// - small conveniences (last page, member filters, the Expiring soon window), and
// - fictional sample data that demo gyms load explicitly (until it moves to a demo gym).
// Older versions saved a whole workspace here. It is only read for the one-time
// "Move my saved data to the cloud" step, then deleted.
// Every read and write is wrapped: storage can be blocked, full or cleared at any time.

const LEGACY_PROTOTYPE_KEY = "gympulse.prototype.v1";
const LEGACY_LANGUAGE_KEY = "gympulse.language";
const UI_KEY = "gympulse.ui.v1";

function storage() {
    try {
        return globalThis.localStorage || null;
    } catch {
        return null;
    }
}

function workspaceKey(userId) {
    return `gympulse.owner.${encodeURIComponent(userId)}.v1`;
}

function readJson(key) {
    try {
        const saved = storage()?.getItem(key);
        if (!saved) return null;
        const value = JSON.parse(saved);
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * What an older version saved for this owner in this browser, or null.
 * The pre-sign-in prototype key is never read: on a shared browser it could hold someone else's data.
 */
export function readSavedWorkspace(userId) {
    return userId ? readJson(workspaceKey(userId)) : null;
}

/** The language an older version saved for every owner of this browser, or "". */
export function readLegacyLanguage() {
    try {
        return storage()?.getItem(LEGACY_LANGUAGE_KEY) || "";
    } catch {
        return "";
    }
}

/** Deletes everything older versions kept for this owner in this browser. */
export function clearSavedWorkspace(userId) {
    const store = storage();
    if (!store) return;
    for (const key of [userId ? workspaceKey(userId) : "", LEGACY_PROTOTYPE_KEY, LEGACY_LANGUAGE_KEY].filter(Boolean)) {
        try {
            store.removeItem(key);
        } catch {
            // Blocked storage has nothing to delete.
        }
    }
}

/** Conveniences only: { view, memberFilter, memberSort, expiringDays }. */
export function readUiPreferences() {
    return readJson(UI_KEY) || {};
}

export function saveUiPreferences(changes) {
    try {
        storage()?.setItem(UI_KEY, JSON.stringify({ ...readUiPreferences(), ...changes }));
    } catch {
        // A convenience; the app works the same without it.
    }
}
