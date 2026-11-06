import { escapeHTML, formatDate, memberStatus, statusPill } from "../utils.js";
import { getPlan } from "../state.js";

export function memberTableRow(member, { includeStatus = true } = {}) {
    const plan = getPlan(member.planId);
    const status = memberStatus(member);
    return `<tr>
        <td><div class="member-cell"><span class="member-avatar">${escapeHTML(member.name.charAt(0).toUpperCase())}</span><span><strong>${escapeHTML(member.name)}</strong><small>${escapeHTML(member.id)}</small></span></div></td>
        <td>${escapeHTML(member.phone)}</td>
        <td>${escapeHTML(plan?.name || "Unassigned")}</td>
        <td>${formatDate(member.expiryDate)}</td>
        ${includeStatus ? `<td>${statusPill(status)}</td>` : ""}
        <td><div class="inline-actions"><button class="text-button" data-action="profile" data-id="${escapeHTML(member.id)}">View</button><button class="text-button" data-action="edit-member" data-id="${escapeHTML(member.id)}">Edit</button></div></td>
    </tr>`;
}

export function emptyRow(colspan, message = "No records found.") {
    return `<tr><td colspan="${colspan}"><div class="empty-state">${escapeHTML(message)}</div></td></tr>`;
}
