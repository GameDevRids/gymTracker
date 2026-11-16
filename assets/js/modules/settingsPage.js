// Settings: a list of sections on the left (desktop) or as the whole page (phone), and the chosen
// section beside it. On a phone, tapping a section shows only that section, with a way back to the
// list. The sections' own content is drawn by their modules; this draws the frame.
import { escapeHTML } from "../utils.js";
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, resolveSection } from "../navigation.js";

const SECTION_INFO = {
    details: ["Gym details", "Name, phone, address, language"],
    payments: ["Payments (UPI)", "Your UPI ID and payment QR"],
    attendance: ["Attendance", "How members check in"],
    renewals: ["Renewals and grace", "Grace days, welcome back discount"],
    holds: ["Plan holds", "Minimum hold and hold fee"],
    messages: ["Messages", "WhatsApp messages, in each language"],
    account: ["Account", "Password, download your data, sign out"],
    help: ["Help and legal", "Report a problem, terms, privacy"]
};

// section: the one shown beside the list. open: on a phone, the section (not the list) is showing.
export const settingsPage = { section: DEFAULT_SETTINGS_SECTION, open: false };

export function settingsSectionLabel(id) {
    return SECTION_INFO[id]?.[0] || "";
}

/** Shows a section. open: also leave the list (phones). Unknown ids show the first section. */
export function showSettingsSection(id, open = true) {
    settingsPage.section = resolveSection(id);
    settingsPage.open = open;
}

/** Back to the list of sections (phones). */
export function showSettingsList() {
    settingsPage.open = false;
}

/**
 * The Settings frame. renderSection(id) draws the section's content (only the chosen one is drawn, so
 * every field id on the page is unique).
 */
export function renderSettingsShell(renderSection) {
    const current = settingsPage.section;
    const items = SETTINGS_SECTIONS.map((id) => {
        const [label, hint] = SECTION_INFO[id];
        return `<button class="settings-nav-item${id === current ? " is-active" : ""}" type="button" data-settings-section="${id}"${id === current ? ' aria-current="page"' : ""}><strong>${escapeHTML(label)}</strong><small>${escapeHTML(hint)}</small></button>`;
    }).join("");
    return `<div class="settings-shell${settingsPage.open ? " is-open" : ""}">
        <nav class="settings-nav" aria-label="Settings sections">${items}</nav>
        <div class="settings-content">
            <button class="text-button settings-back" type="button" data-settings-back>← All settings</button>
            ${renderSection(current)}
        </div>
    </div>`;
}
