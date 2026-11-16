import { escapeHTML } from "../utils.js";

/**
 * An empty list: one line saying why it is empty, and (when there is something to do about it) the
 * button that fixes it. actionHtml is trusted markup from the caller, usually a button.
 */
export function emptyState(message, actionHtml = "") {
    return `<div class="empty-state"><p>${escapeHTML(message)}</p>${actionHtml ? `<div class="empty-actions">${actionHtml}</div>` : ""}</div>`;
}

export function emptyRow(colspan, message = "No records found.", actionHtml = "") {
    return `<tr><td colspan="${colspan}">${emptyState(message, actionHtml)}</td></tr>`;
}
