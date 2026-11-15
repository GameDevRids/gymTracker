import { escapeHTML, formatINR, formatDate, formatPhone, indiaISODate, addDays, daysBetween, statusPill, visitDay } from "../utils.js";
import { drawChartOrEmpty, hasNonZero } from "../components/charts.js";
import { state } from "../state.js";
import { emptyRow } from "../components/tables.js";
import { renderSkeletonList } from "../components/skeleton.js";
import { getCurrentMembership, renewalMemberships } from "./memberMemberships.js";
import { currentSummary, monthLabel } from "./summary.js";
import { paymentsPage } from "./upiPayments.js";
import { renderSetupChecklist } from "./setupChecklist.js";

const greeting = () => {
    const hour = new Date().getHours();
    return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
};

function weekDays() {
    const today = indiaISODate();
    return Array.from({ length: 7 }, (_, index) => {
        const key = addDays(today, index - 6);
        return {
            key,
            label: new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(new Date(`${key}T12:00:00`)),
            count: state.attendance.filter((record) => visitDay(record) === key).length
        };
    });
}

// Latest payments, from the database (Payments list).
function recentPayments() {
    return paymentsPage.payments.slice(0, 10).map((payment) => ({ memberId: payment.member_id, name: payment.member?.full_name, date: payment.paid_on, amount: payment.amount }));
}

function recentRenewals() {
    return renewalMemberships().map((membership) => ({ memberId: membership.member_id, date: String(membership.created_at || membership.start_date).slice(0, 10), plan: membership.plan_name }));
}

export function renderDashboard() {
    const today = indiaISODate();
    const { status, data: summary, message } = currentSummary();
    const heading = `<div class="page-heading"><div><h1>${greeting()} <span aria-hidden="true">✦</span></h1><p>Here’s what’s happening at ${escapeHTML(state.gym.name)} today.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="export-members">↓ Export members</button><button class="button button-secondary" data-action="quick-add-member">Quick add</button><button class="button button-primary" data-action="add-member">＋ Add member</button></div></div>`;
    if (!summary) {
        const body = status === "error"
            ? `<div class="empty-state" role="alert"><p>${escapeHTML(message)}</p><button class="button button-secondary" data-action="retry-summary">Try again</button></div>`
            : `<section class="card skeleton-section">${renderSkeletonList({ count: 4, label: "Loading your gym's totals…", variant: "card" })}</section>`;
        return `${heading}${body}`;
    }
    const attendanceToday = state.attendance.filter((record) => visitDay(record) === today).length;
    const expiringSoon = state.members
        .map((member) => ({ member, membership: getCurrentMembership(member.id) }))
        .filter(({ membership }) => membership?.effective_status === "active" && daysBetween(today, membership.end_date) <= 7)
        .sort((a, b) => a.membership.end_date.localeCompare(b.membership.end_date))
        .slice(0, 5);
    const names = new Map(state.members.map((member) => [member.id, member.name]));
    const recentActivity = [
        ...state.attendance.map((record) => ({ kind: "checked in", memberId: record.memberId, name: record.memberName, date: record.checkedInAt, value: "" })),
        ...recentPayments().map((payment) => ({ kind: "made a payment", memberId: payment.memberId, name: payment.name, date: `${payment.date}T12:00:00`, value: formatINR(payment.amount) })),
        ...state.members.filter((member) => member.joinedAt).map((member) => ({ kind: "joined the gym", memberId: member.id, date: member.createdAt || `${member.joinedAt}T12:00:00`, value: "" })),
        ...recentRenewals().map((renewal) => ({ kind: "renewed membership", memberId: renewal.memberId, date: `${renewal.date}T12:00:00`, value: renewal.plan }))
    ].filter((item) => item.date).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 6);
    const alerts = [
        summary.expiring_in_30_days ? { title: `${summary.expiring_in_30_days} memberships expiring soon`, detail: "Review renewals due in the next 30 days.", view: "renewals" } : null,
        summary.outstanding_total ? { title: `${formatINR(summary.outstanding_total)} in outstanding fees`, detail: `${summary.members_with_balance} member${summary.members_with_balance === 1 ? "" : "s"} with a balance due.`, view: "payments" } : null,
        summary.inactive_members ? { title: `${summary.inactive_members} members may need a check-in`, detail: "Current members with no visit in 14 days. Not a churn prediction.", view: "retention" } : null
    ].filter(Boolean);

    return `${heading}
        ${renderSetupChecklist(summary)}
        <div class="grid kpi-grid">
            ${kpi("Total members", summary.total_members, `${summary.active_members} currently active`, "♙")}
            ${kpi("New members", summary.new_members_this_month, "Joined this month", "✚")}
            ${kpi("Today's attendance", attendanceToday, "Check-ins recorded today", "◷")}
            ${kpi("Revenue collected", formatINR(summary.collected_this_month), "Payments received this month", "₹")}
            ${kpi("Pending payments", formatINR(summary.outstanding_total), "Outstanding member balances", "◌")}
            ${kpi("Expiring soon", summary.expiring_in_30_days, "Memberships due within 30 days", "⟳")}
            ${kpi("Inactive members", summary.inactive_members, "No visit recorded in 14+ days", "♡")}
            ${kpi("Active members", summary.active_members, "Valid membership today", "✓")}
        </div>
        <div class="grid content-grid">
            <section class="card"><div class="card-header"><div><h2>Revenue overview</h2><p>Collected payments · last 6 months</p></div><span class="badge-soft">INR</span></div><div class="chart-area"><canvas id="revenue-chart" aria-label="Revenue for last six months"></canvas><div class="chart-fallback" hidden>Chart library unavailable. Metrics remain available below.</div></div></section>
            <section class="card"><div class="card-header"><div><h2>Actionable alerts</h2><p>Things that may need your attention</p></div></div><div class="card-body"><div class="alert-list">${alerts.length ? alerts.map((alert) => `<button class="alert-item" data-view="${alert.view}"><span class="alert-symbol">!</span><span><strong>${escapeHTML(alert.title)}</strong><p>${escapeHTML(alert.detail)}</p></span></button>`).join("") : `<div class="empty-state">You're all caught up. Nice work!</div>`}</div></div></section>
        </div>
        <div class="grid bottom-grid">
            <section class="card"><div class="card-header"><div><h2>Weekly attendance</h2><p>Recorded visits over the last 7 days</p></div></div><div class="chart-area"><canvas id="attendance-chart" aria-label="Weekly attendance"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
            <section class="card"><div class="card-header"><div><h2>Member growth</h2><p>Total members by month</p></div></div><div class="chart-area"><canvas id="growth-chart" aria-label="Member growth"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
        </div>
        <div class="grid bottom-grid dashboard-secondary-grid">
            <section class="card"><div class="card-header"><div><h2>Membership-plan distribution</h2><p>Current members by plan</p></div></div><div class="chart-area"><canvas id="dashboard-plan-chart" aria-label="Membership plan distribution"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
            <section class="card"><div class="card-header"><div><h2>Recent activity</h2><p>Check-ins, payments, joins and renewals</p></div><button class="text-button" data-view="attendance">Visits</button></div>
                <div class="activity-list">${recentActivity.length ? recentActivity.map((item) => `<div class="activity-row"><span class="activity-dot"></span><span><p><strong>${escapeHTML(names.get(item.memberId) || item.name || "Removed member")}</strong> ${escapeHTML(item.kind)}${item.value ? ` · ${escapeHTML(item.value)}` : ""}</p><small>${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(item.date))}</small></span></div>`).join("") : `<div class="empty-state">No activity recorded yet.</div>`}</div>
            </section>
        </div>
        <section class="card table-card dashboard-watch-card"><div class="card-header"><div><h2>Memberships to keep an eye on</h2><p>Expiring in the next 7 days</p></div><button class="text-button" data-view="renewals">View renewals</button></div><div class="table-wrap"><table><thead><tr><th>Member</th><th>Phone</th><th>Plan</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody>${expiringSoon.map(({ member, membership }) => `<tr><td>${escapeHTML(member.name)} <small class="helper-text">${escapeHTML(member.memberCode || "")}</small></td><td>${escapeHTML(formatPhone(member.phone) || "—")}</td><td>${escapeHTML(membership.plan_name)}</td><td>${formatDate(membership.end_date)}</td><td>${statusPill(membership.effective_status)}</td><td><button class="text-button" data-action="profile" data-id="${escapeHTML(member.id)}">View</button></td></tr>`).join("") || emptyRow(6, "No memberships expiring this week.")}</tbody></table></div></section>`;
}

function kpi(label, value, note, icon) {
    return `<article class="card kpi-card"><div class="kpi-top"><span>${label}</span><span class="kpi-icon">${icon}</span></div><div class="kpi-value">${value}</div><div class="kpi-foot">${note}</div></article>`;
}

export function drawDashboardCharts() {
    const summary = currentSummary().data;
    if (!summary) return;
    if (!window.Chart) {
        document.querySelectorAll(".chart-fallback").forEach((item) => { item.hidden = false; });
        return;
    }
    const months = summary.months || [];
    const days = weekDays();
    const distribution = summary.active_by_plan || [];
    window.gymPulseCharts?.forEach((chart) => chart.destroy());
    const charts = [
        drawChartOrEmpty(document.querySelector("#revenue-chart"), { hasData: hasNonZero(months.map((month) => month.collected)), emptyMessage: "No payments recorded in the last 6 months.", config: {
            type: "line",
            data: { labels: months.map((month) => monthLabel(month.month)), datasets: [{ data: months.map((month) => month.collected), borderColor: "#4b8b59", backgroundColor: "rgba(110,166,100,.12)", fill: true, tension: .38, pointRadius: 3, pointBackgroundColor: "#4b8b59" }] },
            options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => formatINR(context.raw) } } }, scales: { x: { grid: { display: false }, ticks: { color: "#536057", font: { size: 11 } } }, y: { beginAtZero: true, grid: { color: "#eef1ed" }, ticks: { color: "#536057", font: { size: 11 }, callback: (value) => formatINR(value) } } } }
        } }),
        drawChartOrEmpty(document.querySelector("#attendance-chart"), { hasData: hasNonZero(days.map((day) => day.count)), emptyMessage: "No visits recorded in the last 7 days.", config: {
            type: "bar",
            data: { labels: days.map((day) => day.label), datasets: [{ data: days.map((day) => day.count), backgroundColor: "#8fbd7e", borderRadius: 5, maxBarThickness: 26 }] },
            options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { color: "#536057", font: { size: 11 } } }, y: { beginAtZero: true, grid: { color: "#eef1ed" }, ticks: { precision: 0, color: "#536057", font: { size: 11 } } } } }
        } }),
        drawChartOrEmpty(document.querySelector("#growth-chart"), { hasData: hasNonZero(months.map((month) => month.members)), emptyMessage: "No members yet.", config: {
            type: "line",
            data: { labels: months.map((month) => monthLabel(month.month)), datasets: [{ data: months.map((month) => month.members), borderColor: "#d19a57", backgroundColor: "rgba(209,154,87,.12)", fill: true, tension: .35, pointRadius: 3 }] },
            options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#eef1ed" } } } }
        } }),
        drawChartOrEmpty(document.querySelector("#dashboard-plan-chart"), { hasData: distribution.length > 0, emptyMessage: "No active memberships yet.", config: {
            type: "doughnut",
            data: { labels: distribution.map((row) => row.plan_name), datasets: [{ data: distribution.map((row) => row.members), backgroundColor: ["#326a48", "#8db876", "#c4dc86", "#d9a966", "#b8c5ba"], borderWidth: 0 }] },
            options: { maintainAspectRatio: false, cutout: "66%", plugins: { legend: { position: "bottom", labels: { boxWidth: 8, usePointStyle: true, font: { size: 9 } } } } }
        } })
    ].filter(Boolean);
    window.gymPulseCharts = charts;
}
