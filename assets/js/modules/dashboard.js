import { escapeHTML, formatCurrency, formatDate, localISODate, monthKey, daysBetween, statusPill } from "../utils.js";
import { state, memberBalance, getPlan } from "../state.js";
import { emptyRow } from "../components/tables.js";
import { areAllMembershipsLoaded, getAllMemberships } from "./memberMemberships.js";

const sameMonth = (date, month) => String(date || "").slice(0, 7) === month;

function monthSeries(count = 6) {
    const now = new Date();
    return Array.from({ length: count }, (_, index) => {
        const month = new Date(now.getFullYear(), now.getMonth() - (count - index - 1), 1);
        const key = monthKey(month);
        return {
            key,
            label: new Intl.DateTimeFormat("en-IN", { month: "short" }).format(month),
            revenue: state.payments.filter((payment) => payment.status === "paid" && sameMonth(payment.date, key)).reduce((sum, payment) => sum + Number(payment.amount), 0)
        };
    });
}

export function renderDashboard() {
    const today = localISODate();
    const currentMonth = monthKey();
    const memberships = areAllMembershipsLoaded() ? getAllMemberships() : [];
    const activeMemberships = memberships.filter((membership) => membership.effective_status === "active");
    const active = new Set(activeMemberships.map((membership) => membership.member_id)).size;
    const newMembers = state.members.filter((member) => sameMonth(member.joinedAt, currentMonth)).length;
    const attendanceToday = state.attendance.filter((record) => record.checkedInAt.slice(0, 10) === today).length;
    const revenue = state.payments.filter((payment) => payment.status === "paid" && sameMonth(payment.date, currentMonth)).reduce((sum, payment) => sum + Number(payment.amount), 0);
    const outstanding = state.members.reduce((sum, member) => sum + memberBalance(member), 0);
    const expiring = activeMemberships.filter((membership) => {
        const days = daysBetween(today, membership.end_date);
        return days >= 0 && days <= 30;
    }).length;
    const expiringSoon = activeMemberships.filter((membership) => {
        const days = daysBetween(today, membership.end_date);
        return days >= 0 && days <= 7;
    }).slice(0, 5);
    const inactive = state.members.filter((member) => {
        const lastVisit = state.attendance.filter((record) => record.memberId === member.id).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt))[0];
        return !lastVisit || daysBetween(lastVisit.checkedInAt.slice(0, 10)) >= 14;
    }).length;
    const revenueMonths = monthSeries();
    const weekDays = Array.from({ length: 7 }, (_, index) => {
        const date = new Date();
        date.setDate(date.getDate() - (6 - index));
        const key = localISODate(date);
        return {
            key,
            label: new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(date),
            count: state.attendance.filter((record) => record.checkedInAt.slice(0, 10) === key).length
        };
    });
    const recentActivity = [
        ...state.attendance.map((record) => ({ kind: "checked in", memberId: record.memberId, date: record.checkedInAt, value: "" })),
        ...state.payments.map((payment) => ({ kind: "made a payment", memberId: payment.memberId, date: `${payment.date}T12:00:00`, value: formatCurrency(payment.amount) })),
        ...state.members.map((member) => ({ kind: "joined the gym", memberId: member.id, date: `${member.joinedAt}T12:00:00`, value: "" })),
        ...state.members.flatMap((member) => (member.renewals || []).map((renewal) => ({ kind: "renewed membership", memberId: member.id, date: `${renewal.date}T12:00:00`, value: getPlan(renewal.planId)?.name || "" })))
    ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
    const alerts = [
        expiring ? { title: `${expiring} memberships expiring soon`, detail: "Review renewals due in the next 30 days.", view: "renewals" } : null,
        outstanding ? { title: `${formatCurrency(outstanding)} in outstanding fees`, detail: "Follow up on pending and partial payments.", view: "payments" } : null,
        inactive ? { title: `${inactive} members may need a check-in`, detail: "Based on attendance activity, not a churn prediction.", view: "retention" } : null
    ].filter(Boolean);

    return `
        <div class="page-heading"><div><h1>Good ${new Date().getHours() < 12 ? "morning" : "afternoon"}, Alex <span aria-hidden="true">✦</span></h1><p>Here’s what’s happening at ${escapeHTML(state.gym.name)} today.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="export-members">↓ Export members</button><button class="button button-primary" data-action="add-member">＋ Add member</button></div></div>
        <div class="grid kpi-grid">
            ${kpi("Total members", state.members.length, `${active} currently active`, "♙")}
            ${kpi("New members", newMembers, "Joined this month", "✚")}
            ${kpi("Today's attendance", attendanceToday, "Check-ins recorded today", "◷")}
            ${kpi("Revenue collected", formatCurrency(revenue), "Payments received this month", "₹")}
            ${kpi("Pending payments", formatCurrency(outstanding), "Outstanding member balances", "◌")}
            ${kpi("Expiring soon", expiring, "Memberships due within 30 days", "⟳")}
            ${kpi("Inactive members", inactive, "No visit recorded in 14+ days", "♡")}
            ${kpi("Active members", active, "Valid membership today", "✓")}
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
            <section class="card"><div class="card-header"><div><h2>Recent activity</h2><p>Check-ins, payments, joins and renewals</p></div><button class="text-button" data-view="attendance">Attendance</button></div>
                <div class="activity-list">${recentActivity.length ? recentActivity.map((item) => {
                    const member = state.members.find((entry) => entry.id === item.memberId);
                    return `<div class="activity-row"><span class="activity-dot"></span><span><p><strong>${escapeHTML(member?.name || "Removed member")}</strong> ${escapeHTML(item.kind)}${item.value ? ` · ${escapeHTML(item.value)}` : ""}</p><small>${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.date))}</small></span></div>`;
                }).join("") : `<div class="empty-state">No activity recorded yet.</div>`}</div>
            </section>
        </div>
        <section class="card table-card dashboard-watch-card"><div class="card-header"><div><h2>Memberships to keep an eye on</h2><p>Expiring in the next 7 days</p></div><button class="text-button" data-view="renewals">View renewals</button></div><div class="table-wrap"><table><thead><tr><th>Member</th><th>Phone</th><th>Plan</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody>${expiringSoon.map((membership) => {
            const member = state.members.find((item) => item.id === membership.member_id);
            return `<tr><td>${escapeHTML(member?.name || "Member")} <small class="helper-text">${escapeHTML(member?.memberCode || membership.member_id)}</small></td><td>${escapeHTML(member?.phone || "—")}</td><td>${escapeHTML(membership.plan_name)}</td><td>${formatDate(membership.end_date)}</td><td>${statusPill(membership.effective_status)}</td><td><button class="text-button" data-action="profile" data-id="${escapeHTML(membership.member_id)}">View</button></td></tr>`;
        }).join("") || emptyRow(6, areAllMembershipsLoaded() ? "No memberships expiring this week." : "Membership assignments are loading.")}</tbody></table></div></section>`;
}

function kpi(label, value, note, icon) {
    return `<article class="card kpi-card"><div class="kpi-top"><span>${label}</span><span class="kpi-icon">${icon}</span></div><div class="kpi-value">${value}</div><div class="kpi-foot">${note}</div></article>`;
}

export function drawDashboardCharts() {
    if (!window.Chart) {
        document.querySelectorAll(".chart-fallback").forEach((item) => { item.hidden = false; });
        return;
    }
    const activeMemberships = areAllMembershipsLoaded()
        ? getAllMemberships().filter((membership) => membership.effective_status === "active")
        : [];
    const months = monthSeries();
    const dates = Array.from({ length: 7 }, (_, index) => {
        const date = new Date();
        date.setDate(date.getDate() - (6 - index));
        const key = localISODate(date);
        return {
            label: new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(date),
            count: state.attendance.filter((record) => record.checkedInAt.slice(0, 10) === key).length
        };
    });
    const growth = Array.from({ length: 6 }, (_, index) => {
        const month = new Date();
        month.setDate(1);
        month.setMonth(month.getMonth() - (5 - index));
        const lastDay = localISODate(new Date(month.getFullYear(), month.getMonth() + 1, 0));
        return {
            label: new Intl.DateTimeFormat("en-IN", { month: "short" }).format(month),
            members: state.members.filter((member) => member.joinedAt <= lastDay).length
        };
    });
    window.gymPulseCharts?.forEach((chart) => chart.destroy());
    const charts = [
        new window.Chart(document.querySelector("#revenue-chart"), {
            type: "line",
            data: { labels: months.map((month) => month.label), datasets: [{ data: months.map((month) => month.revenue), borderColor: "#4b8b59", backgroundColor: "rgba(110,166,100,.12)", fill: true, tension: .38, pointRadius: 3, pointBackgroundColor: "#4b8b59" }] },
            options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => formatCurrency(context.raw) } } }, scales: { x: { grid: { display: false }, ticks: { color: "#536057", font: { size: 11 } } }, y: { beginAtZero: true, grid: { color: "#eef1ed" }, ticks: { color: "#536057", font: { size: 11 }, callback: (value) => Number(value) >= 1000 ? `₹${Number(value) / 1000}k` : `₹${value}` } } } }
        }),
        new window.Chart(document.querySelector("#attendance-chart"), {
            type: "bar",
            data: { labels: dates.map((day) => day.label), datasets: [{ data: dates.map((day) => day.count), backgroundColor: "#8fbd7e", borderRadius: 5, maxBarThickness: 26 }] },
            options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { color: "#536057", font: { size: 11 } } }, y: { beginAtZero: true, grid: { color: "#eef1ed" }, ticks: { precision: 0, color: "#536057", font: { size: 11 } } } } }
        }),
        new window.Chart(document.querySelector("#growth-chart"), {
            type: "line",
            data: { labels: growth.map((month) => month.label), datasets: [{ data: growth.map((month) => month.members), borderColor: "#d19a57", backgroundColor: "rgba(209,154,87,.12)", fill: true, tension: .35, pointRadius: 3 }] },
            options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#eef1ed" } } } }
        }),
        new window.Chart(document.querySelector("#dashboard-plan-chart"), {
            type: "doughnut",
            data: (() => {
                const distribution = activeMemberships.reduce((counts, membership) => {
                    counts.set(membership.plan_name, (counts.get(membership.plan_name) || 0) + 1);
                    return counts;
                }, new Map());
                return { labels: [...distribution.keys()], datasets: [{ data: [...distribution.values()], backgroundColor: ["#326a48", "#8db876", "#c4dc86", "#d9a966", "#b8c5ba"], borderWidth: 0 }] };
            })(),
            options: { maintainAspectRatio: false, cutout: "66%", plugins: { legend: { position: "bottom", labels: { boxWidth: 8, usePointStyle: true, font: { size: 9 } } } } }
        })
    ];
    window.gymPulseCharts = charts;
}
