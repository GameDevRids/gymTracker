import { escapeHTML, formatINR, formatDate, statusPill } from "../utils.js";
import { state, getMember, getPlan, memberBalance, getMemberPayments } from "../state.js";
import { emptyRow } from "../components/tables.js";
import { getCurrentMembership } from "./memberMemberships.js";

export function renderMembers({ search = "", filter = "all", sort = "name", pagination = { page: 1, limit: 25, total: state.members.length } } = {}) {
    const query = search.trim().toLowerCase();
    const members = [...state.members].filter((member) => {
        const matches = !query || [member.name, member.phone, member.email, member.memberCode || member.id, member.id].some((value) => String(value || "").toLowerCase().includes(query));
        const membershipStatus = getCurrentMembership(member.id)?.effective_status || "unassigned";
        const matchesFilter = filter === "all"
            || (filter === "suspended" ? member.status === "suspended" : membershipStatus === filter);
        return matches && matchesFilter;
    });
    members.sort((a, b) => sort === "expiry" ? a.expiryDate.localeCompare(b.expiryDate) : sort === "joined" ? b.joinedAt.localeCompare(a.joinedAt) : a.name.localeCompare(b.name));
    return `<div class="page-heading"><div><h1>Members</h1><p>Manage your gym community and membership details.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="import-csv">↑ Import CSV</button><button class="button button-secondary" data-action="export-members">↓ Export CSV</button><button class="button button-secondary" data-action="quick-add-member">Quick add</button><button class="button button-primary" data-action="add-member">＋ Add member</button></div></div>
        <div class="toolbar"><input class="search-field" id="member-search" type="search" placeholder="Search name, phone or ID…" value="${escapeHTML(search)}" aria-label="Search members">
            <select class="field-control" id="member-filter" aria-label="Filter members"><option value="all" ${filter === "all" ? "selected" : ""}>All statuses</option><option value="active" ${filter === "active" ? "selected" : ""}>Active</option><option value="upcoming" ${filter === "upcoming" ? "selected" : ""}>Upcoming</option><option value="expired" ${filter === "expired" ? "selected" : ""}>Expired</option><option value="cancelled" ${filter === "cancelled" ? "selected" : ""}>Cancelled</option><option value="unassigned" ${filter === "unassigned" ? "selected" : ""}>Unassigned</option><option value="suspended" ${filter === "suspended" ? "selected" : ""}>Suspended</option></select>
            <select class="field-control" id="member-sort" aria-label="Sort members"><option value="name" ${sort === "name" ? "selected" : ""}>Name A–Z</option><option value="expiry" ${sort === "expiry" ? "selected" : ""}>Expiry date</option><option value="joined" ${sort === "joined" ? "selected" : ""}>Recently joined</option></select><span class="toolbar-spacer"></span><span class="helper-text">Showing ${members.length} of ${pagination.total} member${pagination.total === 1 ? "" : "s"}</span>
        </div>
        <section class="card table-card"><div class="table-wrap"><table class="members-table"><thead><tr><th>Member</th><th>Phone</th><th>Plan</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead><tbody>${members.length ? members.map((member) => memberRow(member)).join("") : emptyRow(6, "No members match these filters.")}</tbody></table></div></section>
        ${pagination.total > pagination.limit ? `<div class="toolbar" aria-label="Member pagination"><span class="toolbar-spacer"></span><button class="button button-secondary" data-action="previous-members-page" ${pagination.page <= 1 ? "disabled" : ""}>Previous</button><span class="helper-text">Page ${pagination.page} of ${Math.ceil(pagination.total / pagination.limit)}</span><button class="button button-secondary" data-action="next-members-page" ${pagination.page >= Math.ceil(pagination.total / pagination.limit) ? "disabled" : ""}>Next</button></div>` : ""}`;
}

function memberRow(member) {
    const membership = getCurrentMembership(member.id);
    const planName = membership?.plan_name || "Unassigned";
    const expiryDate = membership?.end_date || "";
    const membershipStatus = membership?.effective_status || "unassigned";
    return `<tr><td data-label="Member"><button class="text-button member-cell" data-action="profile" data-id="${escapeHTML(member.id)}"><span class="member-avatar">${escapeHTML(member.name.charAt(0))}</span><span><strong>${escapeHTML(member.name)}</strong><small>${escapeHTML(member.memberCode || member.id)}</small></span></button></td><td data-label="Phone">${escapeHTML(member.phone)}</td><td data-label="Plan">${escapeHTML(planName)}</td><td data-label="Expires">${formatDate(expiryDate)}</td><td data-label="Status">${statusPill(membershipStatus)}</td><td data-label="Actions"><div class="inline-actions"><button class="text-button" data-action="assign-member-plan" data-id="${escapeHTML(member.id)}">Assign plan</button><button class="text-button" data-action="edit-member" data-id="${escapeHTML(member.id)}">Edit</button><button class="text-button" data-action="record-payment" data-id="${escapeHTML(member.id)}">Payment</button></div></td></tr>`;
}

export function renderProfile(memberId) {
    const member = getMember(memberId);
    if (!member) return `<div class="page-heading"><div><h1>Member not found</h1><p>This member may have been removed.</p></div><button class="button button-secondary" data-view="members">← Back to members</button></div>`;
    const membership = getCurrentMembership(member.id);
    const planName = membership?.plan_name || getPlan(member.planId)?.name || "Unassigned";
    const payments = getMemberPayments(member.id).sort((a, b) => b.date.localeCompare(a.date));
    const visits = state.attendance.filter((record) => record.memberId === member.id).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt));
    const balance = memberBalance(member);
    return `<div class="page-heading"><div><button class="text-button" data-view="members">← All members</button><h1 class="profile-page-title">Member profile</h1><p>Membership details, attendance and payment history.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="edit-member" data-id="${escapeHTML(member.id)}">Edit profile</button><button class="button button-primary" data-action="assign-member-plan" data-id="${escapeHTML(member.id)}">Assign Plan</button></div></div>
        <div class="profile-layout"><div>
            <section class="card"><div class="card-body"><div class="profile-hero"><span class="profile-large">${escapeHTML(member.name.charAt(0))}</span><div><h2>${escapeHTML(member.name)}</h2><p>${escapeHTML(member.memberCode || member.id)} · Account ${statusPill(member.status === "suspended" ? "suspended" : "active")}</p></div><span class="toolbar-spacer"></span><button class="button button-secondary button-small" data-action="record-payment" data-id="${escapeHTML(member.id)}">＋ Record payment</button></div></div><div class="card-body profile-fields">
                ${detail("Phone", member.phone)}${detail("Email", member.email || "—")}${detail("Date of birth", formatDate(member.dob))}${detail("Gender", member.gender || "—")}${detail("Emergency contact", member.emergencyContact || "—")}${detail("Joined", formatDate(member.joinedAt))}
            </div></section>
            <section class="card profile-section"><div class="card-header"><div><h2>Current membership</h2><p>Current assignment snapshot</p></div></div><div class="card-body" id="member-current-membership" data-member-id="${escapeHTML(member.id)}"><div class="empty-state">Loading membership details…</div></div></section>
            <section class="card profile-section"><div class="card-header"><div><h2>Membership history</h2><p>Plan assignments with historical plan details</p></div></div><div class="activity-list" id="member-membership-history" data-member-id="${escapeHTML(member.id)}"><div class="empty-state">Loading membership history…</div></div></section>
            <section class="card profile-section"><div class="card-header"><div><h2>Payment history</h2><p>Collected transactions for this member</p></div></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th>Receipt</th></tr></thead><tbody>${payments.length ? payments.map((payment) => `<tr><td>${formatDate(payment.date)}</td><td>${formatINR(payment.amount)}</td><td>${escapeHTML(payment.method)}</td><td>${statusPill(payment.status)}</td><td><button class="text-button" data-action="receipt" data-id="${escapeHTML(payment.id)}">Receipt</button></td></tr>`).join("") : emptyRow(5)}</tbody></table></div></section>
            <section class="card profile-section"><div class="card-header"><div><h2>Attendance history</h2><p>Recent recorded check-ins</p></div><button class="text-button" data-view="attendance">View attendance</button></div><div class="table-wrap"><table><thead><tr><th>Check-in</th><th>Check-out</th><th>Source</th></tr></thead><tbody>${visits.slice(0, 8).map((visit) => `<tr><td>${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(visit.checkedInAt))}</td><td>${visit.checkedOutAt ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(visit.checkedOutAt)) : "—"}</td><td>${escapeHTML(visit.source)}</td></tr>`).join("") || emptyRow(3)}</tbody></table></div></section>
        </div><aside>
            <section class="card"><div class="card-header"><h2>Membership</h2></div><div class="card-body profile-fields membership-fields">${detail("Plan", planName)}${detail("Membership period", `${formatDate(membership?.start_date)} – ${formatDate(membership?.end_date)}`)}${detail("Status", membership?.effective_status || "unassigned")}${detail("Total fees", formatINR(member.totalFees))}${detail("Amount paid", formatINR(member.totalFees - balance))}${detail("Outstanding", formatINR(balance))}</div><div class="card-body profile-card-actions"><button class="button button-primary button-full" data-action="renew-member" data-id="${escapeHTML(member.id)}">Renew membership</button></div></section>
            <section class="card profile-section"><div class="card-header"><h2>Renewal history</h2></div><div class="activity-list">${member.renewals?.length ? member.renewals.slice().reverse().map((renewal) => `<div class="activity-row"><span class="activity-dot"></span><span><p>Renewed to <strong>${escapeHTML(getPlan(renewal.planId)?.name || "Membership")}</strong></p><small>${formatDate(renewal.date)} · until ${formatDate(renewal.expiryDate)}</small></span></div>`).join("") : `<div class="empty-state">No renewals recorded yet.</div>`}</div></section>
            <section class="card profile-section"><div class="card-header"><h2>Member actions</h2></div><div class="card-body profile-action-list"><button class="button button-secondary" data-action="check-in" data-id="${escapeHTML(member.id)}">Record check-in</button><button class="button button-secondary" data-action="delete-member" data-id="${escapeHTML(member.id)}">Archive member</button></div></section>
        </aside></div>`;
}

function detail(label, value) {
    return `<div><label>${escapeHTML(label)}</label><strong>${escapeHTML(value)}</strong></div>`;
}
