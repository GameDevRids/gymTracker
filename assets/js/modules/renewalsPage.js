// Renewals: one page for everything about members whose plan is ending or ended, in four tabs:
// Expiring soon, Lapsed, Old members and Follow-ups (the old Retention list). Each tab's list is
// drawn by its own module (expiring.js, lapsed.js, operations.js); this draws the frame.
import { escapeHTML } from "../utils.js";
import { t } from "../i18n.js";
import { RENEWAL_TABS } from "../navigation.js";

const TABS = {
    expiring: { label: () => t("expiring"), description: () => t("expiryDescription"), action: "" },
    lapsed: {
        label: () => "Lapsed",
        description: () => "Grace has run out and they have not renewed yet. Send a friendly message, or renew at the desk.",
        action: `<button class="button button-secondary" data-action="export-renewals">↓ Export renewals</button>`
    },
    old: {
        label: () => "Old members",
        description: () => "Lapsed for longer than your lapsed-list period (Settings › Renewals and grace).",
        action: `<button class="button button-secondary" data-action="export-renewals">↓ Export renewals</button>`
    },
    followups: {
        label: () => "Follow-ups",
        description: () => "Members who may need a nudge, from simple rules (no recent visit, plan ending). These are reminders, not predictions.",
        action: `<button class="button button-secondary" data-action="export-retention">↓ Export CSV</button>`
    }
};

/**
 * The Renewals page. tab: one of RENEWAL_TABS; counts: { expiring, lapsed, old, followups } (a number
 * once that list has loaded, otherwise null); body: the tab's own list, already drawn.
 */
export function renderRenewalsPage({ tab, counts = {}, body }) {
    const current = RENEWAL_TABS.includes(tab) ? tab : RENEWAL_TABS[0];
    const buttons = RENEWAL_TABS.map((id) => {
        const count = Number.isInteger(counts[id]) ? ` <span class="count-pill">${counts[id]}</span>` : "";
        return `<button class="tab-button${id === current ? " is-active" : ""}" type="button" role="tab" id="renewals-tab-${id}" aria-selected="${id === current}" aria-controls="renewals-panel" data-renewals-tab="${id}">${escapeHTML(TABS[id].label())}${count}</button>`;
    }).join("");
    return `<div class="page-heading"><div><h1>Renewals</h1><p>${escapeHTML(TABS[current].description())}</p></div><div class="heading-actions">${TABS[current].action}</div></div>
        <div class="tab-row" role="tablist" aria-label="Renewals">${buttons}</div>
        <div id="renewals-panel" role="tabpanel" aria-labelledby="renewals-tab-${current}">${body}</div>`;
}
