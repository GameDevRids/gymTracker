// The app's pages, where the old ones went, and what the Renewals badge counts. No DOM or app
// imports, so the app and the tests share it.
//
// Sidebar: Today, Members, Check-in, Payments, Renewals, Plans, Reports, Settings. A member's profile
// opens from Members ("profile"). Pages that were merged or removed keep working as links, saved
// pages and #bookmarks: resolveView() sends each to its new home.

export const VIEW_IDS = ["overview", "members", "scan", "payments", "renewals", "plans", "reports", "settings"];
export const RENEWAL_TABS = ["expiring", "lapsed", "old", "followups"];
export const SETTINGS_SECTIONS = ["details", "payments", "attendance", "renewals", "holds", "messages", "account", "help"];
export const DEFAULT_VIEW = "overview";
export const DEFAULT_SETTINGS_SECTION = "details";
export const DEFAULT_RENEWALS_TAB = "expiring";

// Old page id → its new page (and tab). Visits is part of Check-in, Retention is the Follow-ups tab
// of Renewals, Analytics is part of Reports, Expiring soon is the first tab of Renewals; the
// Notifications and Integrations pages are gone (message templates live in Settings).
export const REDIRECTS = {
    expiring: { view: "renewals", tab: "expiring" },
    retention: { view: "renewals", tab: "followups" },
    attendance: { view: "scan" },
    analytics: { view: "reports" },
    notifications: { view: "settings", section: "messages" },
    integrations: { view: "settings" }
};

/**
 * Turns any page id (current, old or unknown) into { view, tab?, section? }. "profile" is a real page but needs
 * a member, so it is returned as is; unknown ids give null.
 */
export function resolveView(id) {
    const name = String(id || "").replace(/^#/, "").trim().toLowerCase();
    if (name === "profile" || VIEW_IDS.includes(name)) return { view: name };
    return Object.hasOwn(REDIRECTS, name) ? { ...REDIRECTS[name] } : null;
}

/** A Settings section id from a link, or the first section. */
export function resolveSection(id) {
    return SETTINGS_SECTIONS.includes(id) ? id : DEFAULT_SETTINGS_SECTION;
}

/** A tab id from a saved preference or a link, or the default. */
export function resolveTab(id) {
    return RENEWAL_TABS.includes(id) ? id : DEFAULT_RENEWALS_TAB;
}

/**
 * How many members on the Expiring list need action: those still to remind (a plan ending in 3 days
 * or fewer, or in grace, who can be reminded and have not been yet: the same "to remind" the tab
 * shows), plus everyone in grace. rows are GET /api/memberships/expiring rows; isBlocked(member) is
 * true for a member who cannot be reminded (no consent, bad number). Members on hold and lapsed
 * members are not on that list.
 */
export function renewalsBadgeCount(rows, isBlocked = () => false) {
    return (rows || []).filter((row) => row.member_status === "in_grace"
        || (row.remindable === true && !row.reminded_at && !isBlocked(row.member))).length;
}
