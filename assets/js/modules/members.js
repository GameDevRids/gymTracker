import { escapeHTML, formatINR, formatDate, formatPhone, statusPill } from "../utils.js";
import { state, getMember, memberBalance, getMemberPayments, consentHistory } from "../state.js";
import { emptyRow } from "../components/tables.js";
import { renderSkeletonList } from "../components/skeleton.js";
import { getCurrentMembership, planNameFor } from "./memberMemberships.js";
import { renderWelcomeSection } from "./welcomeUi.js";
import { renderLinkedPhones, renderMemberVisits } from "./attendance.js";
import { usesMemberQr } from "./checkinMethod.js";
import { avatarHtml, profilePhotoHtml, renderPhotoSection } from "./memberPhotos.js";
import { canImportMembers } from "./memberImportUi.js";

export const MEMBERS_PAGE_SIZE = 50;

/**
 * Every member of the gym is loaded, so search, filters and sorting cover the whole gym.
 * Status filters use the current membership; "Suspended" is the account status.
 */
export function filterMembers({ search = "", filter = "all", sort = "name" } = {}) {
    const query = search.trim().toLowerCase();
    const digits = query.replace(/\D/g, "");
    const members = state.members.filter((member) => {
        const matches = !query
            || [member.name, member.email, member.memberCode].some((value) => String(value || "").toLowerCase().includes(query))
            || (digits.length >= 3 && String(member.phone || "").replace(/\D/g, "").includes(digits));
        const membershipStatus = getCurrentMembership(member.id)?.effective_status || "unassigned";
        const matchesFilter = filter === "all"
            || (filter === "suspended" ? member.status === "suspended" : membershipStatus === filter);
        return matches && matchesFilter;
    });
    const expiry = (member) => getCurrentMembership(member.id)?.end_date || member.expiryDate || "9999-12-31";
    return members.sort((a, b) => sort === "expiry" ? expiry(a).localeCompare(expiry(b))
        : sort === "joined" ? String(b.joinedAt || "").localeCompare(String(a.joinedAt || ""))
            : a.name.localeCompare(b.name));
}

export function renderMembers({ search = "", filter = "all", sort = "name", page = 1, loading = false } = {}) {
    return `<div class="page-heading"><div><h1>Members</h1><p>Manage your gym community and membership details.</p></div><div class="heading-actions">${canImportMembers() ? `<button class="button button-secondary" data-action="import-csv">↑ Import members</button>` : ""}<button class="button button-secondary" data-action="export-members">↓ Export CSV</button><button class="button button-secondary" data-action="quick-add-member">Quick add</button><button class="button button-primary" data-action="add-member">＋ Add member</button></div></div>
        <div class="toolbar"><input class="search-field" id="member-search" type="search" placeholder="Search name, phone or member code…" value="${escapeHTML(search)}" aria-label="Search members" aria-controls="members-results">
            <select class="field-control" id="member-filter" aria-label="Filter members"><option value="all" ${filter === "all" ? "selected" : ""}>All statuses</option><option value="active" ${filter === "active" ? "selected" : ""}>Active</option><option value="upcoming" ${filter === "upcoming" ? "selected" : ""}>Upcoming</option><option value="expired" ${filter === "expired" ? "selected" : ""}>Expired</option><option value="cancelled" ${filter === "cancelled" ? "selected" : ""}>Cancelled</option><option value="unassigned" ${filter === "unassigned" ? "selected" : ""}>Unassigned</option><option value="suspended" ${filter === "suspended" ? "selected" : ""}>Suspended</option></select>
            <select class="field-control" id="member-sort" aria-label="Sort members"><option value="name" ${sort === "name" ? "selected" : ""}>Name A–Z</option><option value="expiry" ${sort === "expiry" ? "selected" : ""}>Expiry date</option><option value="joined" ${sort === "joined" ? "selected" : ""}>Recently joined</option></select>
        </div>
        <div id="members-results" aria-live="polite">${loading ? `<section class="card skeleton-section">${renderSkeletonList({ count: 5, label: "Loading members…" })}</section>` : renderMemberResults({ search, filter, sort, page })}</div>`;
}

/** The count, table and page buttons; redrawn on their own while typing in the search box. */
export function renderMemberResults({ search = "", filter = "all", sort = "name", page = 1 } = {}) {
    const members = filterMembers({ search, filter, sort });
    const pages = Math.max(1, Math.ceil(members.length / MEMBERS_PAGE_SIZE));
    const current = Math.min(Math.max(1, page), pages);
    const shown = members.slice((current - 1) * MEMBERS_PAGE_SIZE, current * MEMBERS_PAGE_SIZE);
    const total = state.members.length;
    const count = members.length === total
        ? `${total} member${total === 1 ? "" : "s"}`
        : `${members.length} of ${total} member${total === 1 ? "" : "s"} match`;
    return `<p class="helper-text members-count">${count}</p>
        <section class="card table-card"><div class="table-wrap"><table class="members-table"><thead><tr><th>Member</th><th>Phone</th><th>Plan</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead><tbody>${shown.length ? shown.map((member) => memberRow(member)).join("") : emptyRow(6, total ? "No members match these filters." : "No members yet. Add your first member to get started.")}</tbody></table></div></section>
        ${pages > 1 ? `<div class="toolbar" aria-label="Member pages"><span class="toolbar-spacer"></span><button class="button button-secondary" data-action="previous-members-page" ${current <= 1 ? "disabled" : ""}>Previous</button><span class="helper-text">Page ${current} of ${pages}</span><button class="button button-secondary" data-action="next-members-page" ${current >= pages ? "disabled" : ""}>Next</button></div>` : ""}`;
}

function memberRow(member) {
    const membership = getCurrentMembership(member.id);
    const planName = membership?.plan_name || "Unassigned";
    const expiryDate = membership?.end_date || "";
    const membershipStatus = membership?.effective_status || "unassigned";
    return `<tr><td data-label="Member"><button class="text-button member-cell" data-action="profile" data-id="${escapeHTML(member.id)}">${avatarHtml(member)}<span><strong>${escapeHTML(member.name)}</strong><small>${escapeHTML(member.memberCode || member.id)}</small></span></button></td><td data-label="Phone">${escapeHTML(formatPhone(member.phone))}</td><td data-label="Plan">${escapeHTML(planName)}</td><td data-label="Expires">${formatDate(expiryDate)}</td><td data-label="Status">${statusPill(membershipStatus)}</td><td data-label="Actions"><div class="inline-actions"><button class="text-button" data-action="renew-member" data-id="${escapeHTML(member.id)}">Renew</button><button class="text-button" data-action="assign-member-plan" data-id="${escapeHTML(member.id)}">Assign plan</button><button class="text-button" data-action="edit-member" data-id="${escapeHTML(member.id)}">Edit</button><button class="text-button" data-action="record-payment" data-id="${escapeHTML(member.id)}">Payment</button></div></td></tr>`;
}

export function renderProfile(memberId) {
    const member = getMember(memberId);
    if (!member) return `<div class="page-heading"><div><h1>Member not found</h1><p>This member may have been removed.</p></div><button class="button button-secondary" data-view="members">← Back to members</button></div>`;
    const membership = getCurrentMembership(member.id);
    const planName = planNameFor(member) || "Unassigned";
    const payments = getMemberPayments(member.id).sort((a, b) => b.date.localeCompare(a.date));
    const visits = state.attendance.filter((record) => record.memberId === member.id).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt));
    const balance = memberBalance(member);
    return `<div class="page-heading"><div><button class="text-button" data-view="members">← All members</button><h1 class="profile-page-title">Member profile</h1><p>Membership details, attendance and payment history.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="edit-member" data-id="${escapeHTML(member.id)}">Edit profile</button><button class="button button-primary" data-action="assign-member-plan" data-id="${escapeHTML(member.id)}">Assign Plan</button></div></div>
        <div class="profile-layout"><div>
            <section class="card"><div class="card-body"><div class="profile-hero">${profilePhotoHtml(member)}<div><h2>${escapeHTML(member.name)}</h2><p>${escapeHTML(member.memberCode || member.id)} · Account ${statusPill(member.status === "suspended" ? "suspended" : "active")}</p></div><span class="toolbar-spacer"></span><button class="button button-secondary button-small" data-action="record-payment" data-id="${escapeHTML(member.id)}">＋ Record payment</button></div></div><div class="card-body profile-fields">
                ${detail("Phone", formatPhone(member.phone) || "—")}${detail("Email", member.email || "—")}${detail("Date of birth", formatDate(member.dob))}${detail("Gender", member.gender || "—")}${detail("Emergency contact", member.emergencyContact || "—")}${detail("Joined", formatDate(member.joinedAt))}
            </div></section>
            <section class="card profile-section"><div class="card-header"><div><h2>Current membership</h2><p>Current assignment snapshot</p></div></div><div class="card-body" id="member-current-membership" data-member-id="${escapeHTML(member.id)}"><div class="empty-state">Loading membership details…</div></div></section>
            <section class="card profile-section"><div class="card-header"><div><h2>Membership history</h2><p>Plan assignments with historical plan details</p></div></div><div class="activity-list" id="member-membership-history" data-member-id="${escapeHTML(member.id)}"><div class="empty-state">Loading membership history…</div></div></section>
            <section class="card profile-section"><div class="card-header"><div><h2>Payment history</h2><p>Collected transactions for this member</p></div></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th>Receipt</th></tr></thead><tbody>${payments.length ? payments.map((payment) => `<tr><td>${formatDate(payment.date)}</td><td>${formatINR(payment.amount)}</td><td>${escapeHTML(payment.method)}</td><td>${statusPill(payment.status)}</td><td><button class="text-button" data-action="receipt" data-id="${escapeHTML(payment.id)}" aria-label="Receipt ${escapeHTML(payment.receiptNumber || "")}">${escapeHTML(payment.receiptNumber ? `Receipt ${payment.receiptNumber}` : "Receipt")}</button></td></tr>`).join("") : emptyRow(5, "No payments recorded for this member yet.")}</tbody></table></div></section>
            ${renderLinkedPhones(member)}
            ${member.memberCode ? renderMemberVisits(member) : `<section class="card profile-section"><div class="card-header"><div><h2>Attendance history</h2><p>Recent recorded check-ins</p></div><button class="text-button" data-view="attendance">View attendance</button></div><div class="table-wrap"><table><thead><tr><th>Check-in</th><th>Check-out</th><th>Source</th></tr></thead><tbody>${visits.slice(0, 8).map((visit) => `<tr><td>${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(visit.checkedInAt))}</td><td>${visit.checkedOutAt ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(visit.checkedOutAt)) : "—"}</td><td>${escapeHTML(visit.source)}</td></tr>`).join("") || emptyRow(3, "No check-ins recorded for this member yet.")}</tbody></table></div></section>`}
        </div><aside>
            <section class="card"><div class="card-header"><h2>Membership</h2></div><div class="card-body profile-fields membership-fields">${detail("Plan", planName)}${detail("Membership period", `${formatDate(membership?.start_date)} – ${formatDate(membership?.end_date)}`)}${detail("Status", membership?.effective_status || "unassigned")}${detail("Total fees", formatINR(member.totalFees))}${detail("Amount paid", formatINR(member.totalFees - balance))}${detail("Outstanding", formatINR(balance))}</div><div class="card-body profile-card-actions"><button class="button button-primary button-full" data-action="renew-member" data-id="${escapeHTML(member.id)}">Renew membership</button></div></section>
            ${renderPhotoSection(member)}
            ${renderConsentSection(member)}
            ${renderWelcomeSection(member)}
            <section class="card profile-section"><div class="card-header"><h2>Member actions</h2></div><div class="card-body profile-action-list"><button class="button button-secondary" data-action="check-in" data-id="${escapeHTML(member.id)}">Record check-in</button>${member.memberCode && usesMemberQr() ? `<button class="button button-secondary" data-action="member-card" data-id="${escapeHTML(member.id)}">Member card</button><button class="button button-secondary" data-action="member-qr-reissue" data-id="${escapeHTML(member.id)}">Reissue QR</button>` : ""}<button class="button button-secondary" data-action="delete-member" data-id="${escapeHTML(member.id)}">Archive member</button></div></section>
        </aside></div>`;
}

const CONSENT_SOURCES = { staff_form: "Member form", csv_import: "CSV import", member_reply_stop: "Member replied STOP" };

function consentDate(value) {
    return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "";
}

/** Current WhatsApp consent plus its full history, newest first. */
export function renderConsentSection(member) {
    const current = member.whatsappOptIn
        ? `<span class="status status-active">Opted in</span><small>since ${escapeHTML(consentDate(member.whatsappOptInAt))}</small>`
        : `<span class="status status-inactive">No consent</span>${member.whatsappOptOutAt ? `<small>withdrawn ${escapeHTML(consentDate(member.whatsappOptOutAt))}</small>` : ""}`;
    const history = consentHistory[member.id];
    // The history also holds photo consent (shown in the Photo section); only WhatsApp here.
    const events = (history?.events || []).filter((event) => (event.channel || "whatsapp") === "whatsapp");
    let list;
    if (!history || history.status === "loading") list = `<div class="empty-state" role="status">Loading consent history…</div>`;
    else if (history.status === "error") list = `<div class="empty-state" role="alert"><p>${escapeHTML(history.message)}</p><button class="button button-secondary" data-action="retry-consent-history" data-id="${escapeHTML(member.id)}">Try again</button></div>`;
    else if (!events.length) list = `<div class="empty-state">No consent recorded yet. Reminders are not sent without consent.</div>`;
    else list = events.map((event) => `<div class="activity-row consent-event"><span class="activity-dot consent-${escapeHTML(event.action)}"></span><span><p><strong>${event.action === "granted" ? "Granted" : "Withdrawn"}</strong> · ${escapeHTML(CONSENT_SOURCES[event.source] || event.source)}</p><small>${escapeHTML(consentDate(event.created_at))}</small></span></div>`).join("");
    return `<section class="card profile-section" id="member-consent"><div class="card-header"><div><h2>WhatsApp consent</h2><p class="consent-current">${current}</p></div></div><div class="activity-list">${list}</div></section>`;
}

function detail(label, value) {
    return `<div><label>${escapeHTML(label)}</label><strong>${escapeHTML(value)}</strong></div>`;
}
