// Lapsed members: grace has run out and they have not renewed (up to the gym's lapsed_list_days
// after their plan ended), and Old members after that. Each row offers "Send renewal message"
// (wa.me, only for members who agreed to WhatsApp messages, logged in their WhatsApp history) and
// Renew. The lists come from the server's shared status rule (GET /api/memberships/lapsed).
import { apiClient } from "../api/apiClient.js";
import { toast } from "../components/toast.js";
import { displayName, escapeHTML, formatDate, formatPhone, messageName } from "../utils.js";
import { state } from "../state.js";
import { getLanguage } from "../i18n.js";
import { welcomePhone } from "../welcomeMessage.js";
import { buildLapsedMessage } from "../lapsedMessage.js";
import { renderSkeletonList } from "../components/skeleton.js";

// One cache per list: { status: "idle" | "loading" | "ready" | "error", rows, message }.
const lists = { lapsed: { status: "idle", rows: [], message: "", loaded: false, request: 0 }, old: { status: "idle", rows: [], message: "", loaded: false, request: 0 } };
let current = "lapsed";

export function lapsedTab() {
    return current;
}

/** Which list the Renewals page shows: "lapsed" or "old". */
export function setLapsedList(list) {
    current = list === "old" ? "old" : "lapsed";
}

/** How many rows a list has once it has loaded, otherwise null (for the tab's count). */
export function lapsedCount(list) {
    return lists[list]?.loaded ? lists[list].rows.length : null;
}

/** Loads one list (lapsed or old) from the server, then calls onChange. */
export async function loadLapsed(list = current, onChange = () => {}) {
    const entry = lists[list];
    const request = ++entry.request;
    // The skeleton is only for the first load: a reload keeps the list (even an empty one) on screen.
    if (!entry.loaded) {
        entry.status = "loading";
        onChange();
    }
    try {
        const response = await apiClient.get("/api/memberships/lapsed", { params: { list } });
        if (request !== entry.request) return;
        entry.rows = Array.isArray(response?.data) ? response.data : [];
        entry.status = "ready";
        entry.loaded = true;
        entry.message = "";
    } catch (error) {
        if (request !== entry.request) return;
        if (!entry.loaded) {
            entry.status = "error";
            entry.message = error.message || "This list could not be loaded.";
        }
    }
    onChange();
}

/** After a renewal: the member leaves both lists at once (the server's lists follow). */
export function dropFromLapsed(memberId) {
    for (const entry of Object.values(lists)) entry.rows = entry.rows.filter((row) => row.member.id !== memberId);
}

/** Refetches whichever lists were already loaded. */
export function reloadLapsed(onChange = () => {}) {
    for (const [list, entry] of Object.entries(lists)) {
        if (entry.status !== "idle") loadLapsed(list, onChange);
    }
}

function ago(days) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
}

function messageLink(row) {
    const phone = welcomePhone(row.member.phone);
    const text = buildLapsedMessage({
        language: getLanguage(),
        name: messageName(row.member.full_name),
        plan: row.plan_name,
        endedOn: formatDate(row.ended_on),
        gymName: state.gym.name,
        gymPhone: state.gym.phone ? formatPhone(state.gym.phone) || state.gym.phone : ""
    });
    return { phone, text };
}

function messageAction(row) {
    if (row.member.whatsapp_opt_in !== true) return `<span class="helper-text reminder-blocked">No WhatsApp consent</span>`;
    const { phone, text } = messageLink(row);
    if (!phone) return `<span class="helper-text reminder-blocked">No valid mobile number</span>`;
    const sent = row.renewal_message_sent_at ? `<small class="helper-text">Sent ${escapeHTML(formatDate(String(row.renewal_message_sent_at).slice(0, 10)))}</small>` : "";
    return `<a class="button button-secondary button-small" href="https://wa.me/91${phone}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener noreferrer" data-lapsed-message="${escapeHTML(row.member.id)}">Send renewal message</a>${sent}`;
}

function rowHtml(row) {
    const id = escapeHTML(row.member.id);
    return `<article class="card lapsed-card">
        <div class="lapsed-member"><button class="text-button member-cell" data-action="profile" data-id="${id}"><strong>${escapeHTML(displayName(row.member.full_name))}</strong></button><small>${escapeHTML(formatPhone(row.member.phone))}</small></div>
        <div class="lapsed-detail"><small>${escapeHTML(row.plan_name || "Plan")}</small><strong>Ended ${escapeHTML(formatDate(row.ended_on))}</strong><small>${escapeHTML(ago(row.days_since_end))}</small></div>
        <div class="lapsed-actions"><button class="button button-primary button-small" data-action="renew-member" data-id="${id}">Renew</button>${messageAction(row)}</div>
    </article>`;
}

/** The Lapsed or Old members list (the Renewals page draws the heading and tabs around it). */
export function renderLapsedBody(list = current) {
    const entry = lists[list];
    let body;
    if (entry.status === "loading" || entry.status === "idle") body = renderSkeletonList({ count: 3, label: "Loading members…", variant: "card" });
    else if (entry.status === "error") body = `<div class="empty-state" role="alert"><p>${escapeHTML(entry.message)}</p><button class="button button-secondary" type="button" data-action="retry-lapsed">Try again</button></div>`;
    else if (!entry.rows.length) body = `<div class="empty-state">${list === "lapsed" ? "No lapsed members – nice! Everyone whose grace ran out has renewed." : "No old members. Members move here when they stay lapsed past your lapsed-list period."}</div>`;
    else body = `<div class="lapsed-list">${entry.rows.map(rowHtml).join("")}</div>`;
    return body;
}

/** Logs a renewal message the moment its link opens WhatsApp. Never blocks the link. */
async function logMessage(memberId) {
    const row = lists[current].rows.find((item) => item.member.id === memberId);
    if (!row) return;
    const { text } = messageLink(row);
    row.renewal_message_sent_at = new Date().toISOString();
    try {
        await apiClient.post(`/api/members/${memberId}/whatsapp-messages`, { reminder_type: "lapsed", language: getLanguage(), body: text });
    } catch (error) {
        toast(`WhatsApp opened, but the message was not added to the history: ${error.message || "please try again"}`, "error");
    }
}

/** Handles taps on the lists' message links. Returns true when handled. */
export function handleLapsedClick(target, onChange) {
    const link = target.closest("[data-lapsed-message]");
    if (link) {
        logMessage(link.dataset.lapsedMessage).then(onChange);
        return true;
    }
    return false;
}
