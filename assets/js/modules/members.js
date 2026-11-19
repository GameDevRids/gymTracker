import { isVoidedPayment, voidButton, voidNote } from "./paymentVoid.js";
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
import { STATUS_LABELS } from "../memberStatus.js";
import { holdNote, renderHoldSection } from "./holds.js";

const STATUS_FILTERS = [["active", "Active"], ["expiring", "Expiring"], ["in_grace", "In grace"], ["lapsed", "Lapsed"], ["old", "Old members"], ["upcoming", "Upcoming"], ["on_hold", "On hold"], ["none", "No plan"], ["blocked", "Blocked"]];

// "Blocked" is the old "Suspended" account flag (members.status), no longer set from the app. It is
// shown as a tag beside the member's real status, never instead of it.
export function blockedTag(member) {
    return member.status === "suspended" ? `<span class="tag tag-blocked" title="Marked Suspended in an earlier version">Blocked</span>` : "";
}

/** The member's status from the shared rule (server), as a pill. */
export function memberStatusPill(member) {
    const status = member.memberStatus;
    if (!status) return statusPill(getCurrentMembership(member.id)?.effective_status || "unassigned");
    return `<span class="status status-${escapeHTML(status)}">${escapeHTML(STATUS_LABELS[status] || status)}</span>`;
}

/** One short line with the dates behind the status: days left, grace till, or when it ended. */
export function memberStatusNote(member) {
    const detail = member.statusDetail || {};
    switch (member.memberStatus) {
        case "expiring": return detail.days_left === 0 ? "Ends today" : `${detail.days_left} day${detail.days_left === 1 ? "" : "s"} left`;
        case "in_grace": return `Plan ended ${formatDate(detail.ended_on)} · grace till ${formatDate(detail.grace_until)}`;
        case "lapsed":
        case "old": return `Plan ended ${formatDate(detail.ended_on)}`;
        case "upcoming": return detail.next_start ? `Starts ${formatDate(detail.next_start)}` : "";
        case "on_hold": return holdNote(detail);
        default: return "";
    }
}

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
            || [member.name, member.email, member.memberCode, member.previousCode].some((value) => String(value || "").toLowerCase().includes(query))
            || (digits.length >= 3 && String(member.phone || "").replace(/\D/g, "").includes(digits));
        const matchesFilter = filter === "all"
            || (filter === "blocked" ? member.status === "suspended" : member.memberStatus === filter);
        return matches && matchesFilter;
    });
    const expiry = (member) => getCurrentMembership(member.id)?.end_date || member.expiryDate || "9999-12-31";
    return members.sort((a, b) => sort === "expiry" ? expiry(a).localeCompare(expiry(b))
        : sort === "joined" ? String(b.joinedAt || "").localeCompare(String(a.joinedAt || ""))
            : a.name.localeCompare(b.name));
}

export function renderMembers({ search = "", filter = "all", sort = "name", page = 1, loading = false } = {}) {
    return `<div class="page-heading"><div><h1>Members</h1><p>Manage your gym community and membership details.</p></div><div class="heading-actions"><button class="button button-primary" type="button" data-action="add-member">＋ Add member</button>${membersHeaderMenu()}</div></div>
        <div class="toolbar"><input class="search-field" id="member-search" type="search" placeholder="Search name or phone" value="${escapeHTML(search)}" aria-label="Search members" aria-controls="members-results">
            <select class="field-control" id="member-filter" aria-label="Filter members"><option value="all" ${filter === "all" ? "selected" : ""}>All statuses</option>${STATUS_FILTERS.map(([value, label]) => `<option value="${value}" ${filter === value ? "selected" : ""}>${label}</option>`).join("")}</select>
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
        <section class="card table-card"><div class="table-wrap"><table class="members-table"><thead><tr><th>Member</th><th>Phone</th><th>Plan</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead><tbody>${shown.length ? shown.map((member) => memberRow(member)).join("") : emptyRow(6, total ? "No members match this search or filter." : "No members yet. Add your first member, or import a spreadsheet.", total ? `<button class="button button-secondary" type="button" data-action="clear-member-filters">Clear filters</button>` : `<button class="button button-secondary" type="button" data-action="add-member">Add member</button>${canImportMembers() ? `<button class="button button-secondary" type="button" data-action="import-csv">Import members</button>` : ""}`)}</tbody></table></div></section>
        ${pages > 1 ? `<div class="toolbar" aria-label="Member pages"><span class="toolbar-spacer"></span><button class="button button-secondary" data-action="previous-members-page" ${current <= 1 ? "disabled" : ""}>Previous</button><span class="helper-text">Page ${current} of ${pages}</span><button class="button button-secondary" data-action="next-members-page" ${current >= pages ? "disabled" : ""}>Next</button></div>` : ""}`;
}

function memberRow(member) {
    const membership = getCurrentMembership(member.id);
    const planName = membership?.plan_name || "Unassigned";
    const expiryDate = membership?.end_date || "";
    return `<tr class="member-row" data-row-profile="${escapeHTML(member.id)}"><td data-label="Member"><button class="text-button member-cell${member.nameMissing ? " name-missing" : ""}" data-action="${member.nameMissing ? "edit-member" : "profile"}" data-id="${escapeHTML(member.id)}">${avatarHtml(member)}<span><strong>${escapeHTML(member.name)}</strong><small>${escapeHTML(member.memberCode || member.id)}</small></span></button></td><td data-label="Phone">${escapeHTML(formatPhone(member.phone))}</td><td data-label="Plan">${escapeHTML(planName)}</td><td data-label="Expires">${formatDate(expiryDate)}</td><td data-label="Status">${memberStatusPill(member)}${blockedTag(member)}${memberStatusNote(member) ? `<small class="cell-sub">${escapeHTML(memberStatusNote(member))}</small>` : ""}</td><td data-label="Actions">${rowActions(member)}</td></tr>`;
}

const holdIdFor = (member) => member?.statusDetail?.hold?.id || "";

/** Statuses whose row needs a renewal: Renew is the row's marigold button. */
export const RENEW_STATUSES = new Set(["expiring", "in_grace", "lapsed", "old"]);

/**
 * The one button in a member's row, or null:
 * - expiring, in grace, lapsed, old: Renew (marigold)
 * - on hold: Resume (opens the Resume sheet; without the hold's id it opens Renew, which says
 *   "Resume the plan first" and offers Resume)
 * - no plan: Assign plan
 * - active, upcoming: none; everything is in the "⋯" menu (Renew included)
 */
export function rowPrimaryAction(member) {
    const status = member.memberStatus;
    if (RENEW_STATUSES.has(status)) return { action: "renew-member", label: "Renew", hold: "", style: "button-primary" };
    if (status === "on_hold") {
        const hold = holdIdFor(member);
        return { action: hold ? "hold-resume" : "renew-member", label: "Resume", hold, style: "button-secondary" };
    }
    if (status === "none") return { action: "assign-member-plan", label: "Assign plan", hold: "", style: "button-secondary" };
    return null;
}

/**
 * The "⋯" menu: Renew when it is not the row's button (and the plan is not on hold), Resume on hold,
 * Edit, Record payment, Assign plan (no plan), Put on hold (plan running), then a divider and Delete.
 */
export function memberMenuItems(member) {
    const status = member.memberStatus;
    const items = [];
    if (status === "on_hold") {
        const hold = holdIdFor(member);
        items.push({ action: hold ? "hold-resume" : "renew-member", label: "Resume", hold });
    } else if (status !== "none" && !RENEW_STATUSES.has(status)) {
        items.push({ action: "renew-member", label: "Renew" });
    }
    items.push({ action: "edit-member", label: "Edit" }, { action: "record-payment", label: "Record payment" });
    if (status === "none") items.push({ action: "assign-member-plan", label: "Assign plan" });
    if (status === "active" || status === "expiring") items.push({ action: "hold-start", label: "Put on hold" });
    items.push({ divider: true }, { action: "delete-member", label: "Delete member", danger: true });
    return items;
}

const holdAttr = (hold) => (hold ? ` data-hold="${escapeHTML(hold)}"` : "");

/** Menu items as buttons, with a divider line where asked. */
export function menuItemsHtml(items, id = "") {
    return items.map((item) => (item.divider ? `<div class="row-menu-divider" role="separator"></div>`
        : `<button class="row-menu-item${item.danger ? " is-danger" : ""}" type="button" role="menuitem" data-action="${item.action}"${id ? ` data-id="${escapeHTML(id)}"` : ""}${holdAttr(item.hold)}>${escapeHTML(item.label)}</button>`)).join("");
}

const menuWrap = (label, items) => `<div class="row-menu-wrap"><button class="row-menu-button" type="button" data-action="row-menu" aria-haspopup="menu" aria-expanded="false" aria-label="${label}">⋯</button><div class="row-menu" role="menu" aria-label="${label}" hidden>${items}</div></div>`;

/** Members header: Import members (owner) and Export CSV, behind "⋯". */
function membersHeaderMenu() {
    const items = [...(canImportMembers() ? [{ action: "import-csv", label: "Import members" }] : []), { action: "export-members", label: "Export CSV" }];
    return menuWrap("More member actions", menuItemsHtml(items));
}

function rowActions(member) {
    const id = escapeHTML(member.id);
    const main = rowPrimaryAction(member);
    const button = main ? `<button class="button ${main.style} button-small" type="button" data-action="${main.action}" data-id="${id}"${holdAttr(main.hold)}>${main.label}</button>` : "";
    return `<div class="row-actions">${button}${menuWrap(`More actions for ${escapeHTML(member.name)}`, menuItemsHtml(memberMenuItems(member), member.id))}</div>`;
}

export function renderProfile(memberId) {
    const member = getMember(memberId);
    if (!member) return `<div class="page-heading"><div><h1>Member not found</h1><p>This member may have been removed.</p></div><button class="button button-secondary" data-view="members">← Back to members</button></div>`;
    const membership = getCurrentMembership(member.id);
    const planName = planNameFor(member) || "Unassigned";
    const payments = getMemberPayments(member.id).sort((a, b) => b.date.localeCompare(a.date));
    const visits = state.attendance.filter((record) => record.memberId === member.id).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt));
    const balance = memberBalance(member);
    return `<div class="page-heading"><div><button class="text-button" data-view="members">← All members</button><h1 class="profile-page-title">Member profile</h1><p>Membership details, attendance and payment history.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="edit-member" data-id="${escapeHTML(member.id)}">Edit profile</button><button class="button button-secondary" data-action="assign-member-plan" data-id="${escapeHTML(member.id)}">Assign plan</button></div></div>
        <div class="profile-layout"><div>
            <section class="card"><div class="card-body"><div class="profile-hero">${profilePhotoHtml(member)}<div><h2>${member.nameMissing ? `<button class="text-button name-missing" type="button" data-action="edit-member" data-id="${escapeHTML(member.id)}">${escapeHTML(member.name)}</button>` : escapeHTML(member.name)}</h2><p>${escapeHTML(member.memberCode || member.id)}${blockedTag(member) ? ` · ${blockedTag(member)}` : ""}</p></div><span class="toolbar-spacer"></span><button class="button button-secondary button-small" data-action="record-payment" data-id="${escapeHTML(member.id)}">Record payment</button></div></div><div class="card-body profile-fields">
                ${detail("Phone", formatPhone(member.phone) || "—")}${detail("Email", member.email || "—")}${detail("Date of birth", formatDate(member.dob))}${detail("Gender", member.gender || "—")}${detail("Emergency contact", member.emergencyContact || "—")}${detail("Joined", formatDate(member.joinedAt))}
            </div></section>
            <section class="card profile-section"><div class="card-header"><div><h2>Current membership</h2><p>Current assignment snapshot</p></div></div><div class="card-body" id="member-current-membership" data-member-id="${escapeHTML(member.id)}"><div class="empty-state">Loading membership details…</div></div></section>
            <section class="card profile-section"><div class="card-header"><div><h2>Membership history</h2><p>Plan assignments with historical plan details</p></div></div><div class="activity-list" id="member-membership-history" data-member-id="${escapeHTML(member.id)}"><div class="empty-state">Loading membership history…</div></div></section>
            ${renderHoldSection(member)}
            <section class="card profile-section"><div class="card-header"><div><h2>Payment history</h2><p>Collected transactions for this member</p></div></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th>Receipt</th></tr></thead><tbody>${payments.length ? payments.map((payment) => `<tr class="${isVoidedPayment(payment) ? "is-voided" : ""}"><td>${formatDate(payment.date)}</td><td>${isVoidedPayment(payment) ? `<s class="voided-amount">${formatINR(payment.amount)}</s>` : formatINR(payment.amount)}${payment.kind === "hold_fee" ? `<small class="cell-sub">Hold fee</small>` : ""}${voidNote(payment)}</td><td>${escapeHTML(payment.method)}</td><td>${statusPill(payment.status)}</td><td><span class="payment-row-actions"><button class="text-button" data-action="receipt" data-id="${escapeHTML(payment.id)}" aria-label="Receipt ${escapeHTML(payment.receiptNumber || "")}">${escapeHTML(payment.receiptNumber ? `Receipt ${payment.receiptNumber}` : "Receipt")}</button>${voidButton(payment, payment.receiptNumber)}</span></td></tr>`).join("") : emptyRow(5, "No payments yet. They appear here when you renew or record one.", `<button class="button button-secondary" type="button" data-action="record-payment" data-id="${escapeHTML(member.id)}">Record payment</button>`)}</tbody></table></div></section>
            ${renderLinkedPhones(member)}
            ${member.memberCode ? renderMemberVisits(member) : `<section class="card profile-section"><div class="card-header"><div><h2>Attendance history</h2><p>Recent recorded check-ins</p></div><button class="text-button" data-view="attendance">View attendance</button></div><div class="table-wrap"><table><thead><tr><th>Check-in</th><th>Check-out</th><th>Source</th></tr></thead><tbody>${visits.slice(0, 8).map((visit) => `<tr><td>${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(visit.checkedInAt))}</td><td>${visit.checkedOutAt ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(visit.checkedOutAt)) : "—"}</td><td>${escapeHTML(visit.source)}</td></tr>`).join("") || emptyRow(3, "No check-ins yet. They appear here as this member checks in.", `<button class="button button-secondary" type="button" data-action="check-in" data-id="${escapeHTML(member.id)}">Check in</button>`)}</tbody></table></div></section>`}
        </div><aside>
            <section class="card"><div class="card-header"><h2>Membership</h2></div><div class="card-body profile-fields membership-fields">${detail("Plan", planName)}${detail("Membership period", `${formatDate(membership?.start_date)} – ${formatDate(membership?.end_date)}`)}${detail("Status", `${STATUS_LABELS[member.memberStatus] || membership?.effective_status || "No plan"}${memberStatusNote(member) ? ` · ${memberStatusNote(member)}` : ""}`)}${detail("Total fees", formatINR(member.totalFees))}${detail("Amount paid", formatINR(member.totalFees - balance))}${detail("Outstanding", formatINR(balance))}</div><div class="card-body profile-card-actions">${(() => { const main = rowPrimaryAction(member)?.action === "assign-member-plan" || !rowPrimaryAction(member) ? { action: "renew-member", label: "Renew", hold: "" } : rowPrimaryAction(member); return `<button class="button button-primary button-full" data-action="${main.action}" data-id="${escapeHTML(member.id)}"${holdAttr(main.hold)}>${main.label}</button>`; })()}</div></section>
            ${renderPhotoSection(member)}
            ${renderConsentSection(member)}
            ${renderWelcomeSection(member)}
            <section class="card profile-section"><div class="card-header"><h2>Member actions</h2></div><div class="card-body profile-action-list"><button class="button button-secondary" data-action="check-in" data-id="${escapeHTML(member.id)}">Check in</button>${member.memberCode && usesMemberQr() ? `<button class="button button-secondary" data-action="member-card" data-id="${escapeHTML(member.id)}">Member card</button><button class="button button-secondary" data-action="member-qr-reissue" data-id="${escapeHTML(member.id)}">Reissue QR</button>` : ""}<button class="button button-secondary" data-action="delete-member" data-id="${escapeHTML(member.id)}">Delete member</button></div></section>
        </aside></div>`;
}

const CONSENT_SOURCES = { staff_form: "Recorded by staff", csv_import: "CSV import", member_reply_stop: "Member replied STOP", enquiry: "Agreed when they enquired", member_desk: "Member agreed at the desk" };

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
