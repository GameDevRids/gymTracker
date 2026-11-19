import { addDays, displayName, escapeHTML, formatINR, indiaISODate, visitDay } from "../utils.js";
import { drawChartOrEmpty, hasNonZero } from "../components/charts.js";
import { state } from "../state.js";
import { renderSkeletonList } from "../components/skeleton.js";
import { renewalMemberships } from "./memberMemberships.js";
import { currentMemberCount, currentSummary, monthLabel } from "./summary.js";
import { paymentsPage } from "./upiPayments.js";
import { renderSetupChecklist } from "./setupChecklist.js";
import { retentionRows } from "./operations.js";
import { dueEnquiries } from "./enquiriesPage.js";
import { isVoided } from "../paymentRules.js";

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

/**
 * When a payment happened, for the activity feed: { at, dateOnly }. The time it was recorded
 * (created_at) is shown when that is the same India day as the payment date; a payment dated another
 * day (backdated, or imported) has no real time of day, so only its date is shown.
 */
export function paymentMoment(payment) {
    const day = String(payment?.paid_on || "").slice(0, 10);
    const recorded = payment?.created_at ? new Date(payment.created_at) : null;
    if (recorded && !Number.isNaN(recorded.getTime()) && (!day || indiaISODate(recorded) === day)) return { at: recorded.toISOString(), dateOnly: false };
    return day ? { at: `${day}T12:00:00+05:30`, dateOnly: true } : { at: "", dateOnly: true };
}

// Latest payments, from the database (Payments list). Voided payments are not money received, so
// they are left out of the feed (the Payments list and profile still show them, marked Voided).
export function recentPayments(payments = paymentsPage.payments) {
    return (payments || []).filter((payment) => !isVoided(payment)).slice(0, 10).map((payment) => ({
        memberId: payment.member_id,
        name: payment.member ? displayName(payment.member.full_name) : "Removed member",
        ...paymentMoment(payment),
        amount: payment.amount
    }));
}

function recentRenewals() {
    return renewalMemberships().map((membership) => membership.created_at
        ? { memberId: membership.member_id, at: new Date(membership.created_at).toISOString(), dateOnly: false, plan: membership.plan_name }
        : { memberId: membership.member_id, at: `${membership.start_date}T12:00:00+05:30`, dateOnly: true, plan: membership.plan_name });
}

const FEED_DATE = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const FEED_DATE_TIME = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

/** "20 Nov 2026, 9:42 am", or just "20 Nov 2026" when only the date is known. */
export function feedWhen(item) {
    const date = new Date(item.at);
    if (Number.isNaN(date.getTime())) return "";
    return (item.dateOnly ? FEED_DATE : FEED_DATE_TIME).format(date);
}

/** The Today page header: a small greeting, and three actions with Add member the one marigold button. */
export function todayHeading(gymName) {
    return `<div class="page-heading today-heading"><div><h1>${greeting()}</h1><p>Here’s what’s happening at ${escapeHTML(gymName)} today.</p></div><div class="heading-actions"><button class="button button-secondary" type="button" data-view="scan">Check in</button><button class="button button-secondary" type="button" data-action="record-payment">Record payment</button><button class="button button-primary" type="button" data-action="add-member">＋ Add member</button></div></div>`;
}

export function renderDashboard() {
    const today = indiaISODate();
    const { status, data: summary, message } = currentSummary();
    const heading = todayHeading(state.gym.name);
    if (!summary) {
        const body = status === "error"
            ? `<div class="empty-state" role="alert"><p>${escapeHTML(message)}</p><button class="button button-secondary" data-action="retry-summary">Try again</button></div>`
            : `<section class="card skeleton-section">${renderSkeletonList({ count: 4, label: "Loading your gym's totals…", variant: "card" })}</section>`;
        return `${heading}${body}`;
    }
    const attendanceToday = state.attendance.filter((record) => visitDay(record) === today).length;
    const names = new Map(state.members.map((member) => [member.id, member.name]));
    const recentActivity = [
        ...state.attendance.map((record) => ({ kind: "checked in", memberId: record.memberId, name: record.memberName, at: record.checkedInAt, dateOnly: false, value: "" })),
        ...recentPayments().map((payment) => ({ kind: "made a payment", memberId: payment.memberId, name: payment.name, at: payment.at, dateOnly: payment.dateOnly, value: formatINR(payment.amount) })),
        ...state.members.filter((member) => member.joinedAt).map((member) => ({ kind: "joined the gym", memberId: member.id, at: member.createdAt || `${member.joinedAt}T12:00:00+05:30`, dateOnly: !member.createdAt, value: "" })),
        ...recentRenewals().map((renewal) => ({ kind: "renewed membership", memberId: renewal.memberId, at: renewal.at, dateOnly: renewal.dateOnly, value: renewal.plan }))
    ].filter((item) => item.at && !Number.isNaN(new Date(item.at).getTime()))
        .sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 6);
    // What to do today comes first, then setting up, then today's numbers and what just happened.
    return `${heading}
        ${needsAttention(summary)}
        ${renderSetupChecklist(summary)}
        <div class="grid kpi-grid">
            ${kpi("Total members", summary.total_members, `${currentMemberCount(summary)} with a plan running today`, "♙")}
            ${kpi("New members", summary.new_members_this_month, "Joined this month", "✚")}
            ${kpi("Today's attendance", attendanceToday, "Check-ins recorded today", "◷")}
            ${kpi("Revenue collected", formatINR(summary.collected_this_month), "Payments received this month", "₹")}
            ${kpi("Pending payments", formatINR(summary.outstanding_total), "Outstanding member balances", "◌")}
            ${kpi("Expiring soon", summary.status_counts?.expiring ?? summary.expiring_in_7_days, "Plans ending within 7 days", "⟳")}
            ${kpi("Inactive members", summary.inactive_members, "No visit in 14+ days since joining or last visit", "♡")}
            ${kpi("Active members", currentMemberCount(summary), "Plan running today (Active or Expiring)", "✓")}
        </div>
        <section class="card activity-card"><div class="card-header"><div><h2>Recent activity</h2><p>Check-ins, payments, joins and renewals</p></div><button class="text-button" data-view="attendance">Visits</button></div>
            <div class="activity-list">${recentActivity.length ? recentActivity.map((item) => `<div class="activity-row"><span class="activity-dot"></span><span><p><strong>${escapeHTML(names.get(item.memberId) || item.name || "Removed member")}</strong> ${escapeHTML(item.kind)}${item.value ? ` · ${escapeHTML(item.value)}` : ""}</p><small>${escapeHTML(feedWhen(item))}</small></span></div>`).join("") : `<div class="empty-state"><p>No activity yet. Check-ins, payments, renewals and new members show up here.</p></div>`}</div>
        </section>
        <div class="grid content-grid is-single">
            <section class="card"><div class="card-header"><div><h2>Revenue overview</h2><p>Collected payments · last 6 months</p></div><span class="badge-soft">INR</span></div><div class="chart-area"><canvas id="revenue-chart" aria-label="Revenue for last six months"></canvas><div class="chart-fallback" hidden>Chart library unavailable. Metrics remain available below.</div></div></section>
        </div>
        <div class="grid bottom-grid">
            <section class="card"><div class="card-header"><div><h2>Weekly attendance</h2><p>Recorded visits over the last 7 days</p></div></div><div class="chart-area"><canvas id="attendance-chart" aria-label="Weekly attendance"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
            <section class="card"><div class="card-header"><div><h2>Member growth</h2><p>Total members by month</p></div></div><div class="chart-area"><canvas id="growth-chart" aria-label="Member growth"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
        </div>`;
}

/** Members whose hold is planned to end within the next 7 days (or should already have ended). */
export function holdsEndingThisWeek(members = state.members, today = indiaISODate()) {
    const limit = addDays(today, 7);
    return members.filter((member) => {
        const hold = member.memberStatus === "on_hold" ? member.statusDetail?.hold : null;
        const back = hold?.return_by || hold?.planned_return_on || "";
        return Boolean(back) && back <= limit;
    }).length;
}

/**
 * "Needs attention": what to do today, each card opening its list. Only things with a count above 0
 * are shown; when every count is 0 it is one line, "All caught up for today".
 * Order: dues, follow-ups, enquiries, in grace, holds ending this week, then plans expiring this week.
 */
export function attentionItems(summary, followups, enquiriesDue = null, holdsEnding = 0) {
    const counts = summary.status_counts;
    return [
        { key: "dues", label: "Dues", value: summary.members_with_balance ?? 0, note: `${formatINR(summary.outstanding_total || 0)} outstanding`, view: "payments", tab: "" },
        { key: "followups", label: "Follow-ups", value: followups, note: "Members who may need a nudge", view: "renewals", tab: "followups" },
        { key: "enquiries", label: "Enquiries to follow up", value: enquiriesDue ?? summary.enquiries_due ?? 0, note: "Follow-ups due today or overdue", view: "enquiries", tab: "today" },
        { key: "in_grace", label: "In grace", value: counts?.in_grace ?? 0, note: "Plan ended, grace still running", view: "renewals", tab: "expiring" },
        { key: "holds_ending", label: "Holds ending this week", value: holdsEnding, note: "Planned return within 7 days", view: "members", tab: "on_hold" },
        { key: "expiring", label: "Expiring this week", value: counts?.expiring ?? summary.expiring_in_7_days ?? 0, note: "Plans ending within 7 days", view: "renewals", tab: "expiring" }
    ];
}

function needsAttention(summary) {
    return renderNeedsAttention(summary, state.members.length ? retentionRows().length : Number(summary.inactive_members) || 0, dueEnquiries(), holdsEndingThisWeek());
}

/** The Needs attention block for these totals. */
export function renderNeedsAttention(summary, followups, enquiriesDue = null, holdsEnding = 0) {
    const open = attentionItems(summary, followups, enquiriesDue, holdsEnding).filter((item) => Number(item.value) > 0);
    if (!open.length) return `<p class="attention-clear is-all" role="status">✓ All caught up for today</p>`;
    const buttons = open.map((item) => `<button class="attention-item" type="button" data-view="${item.view}"${item.tab ? ` data-tab="${item.tab}"` : ""}><strong>${Number(item.value)}</strong><span>${escapeHTML(item.label)}<small>${escapeHTML(item.note)}</small></span></button>`).join("");
    return `<section class="card attention-card" aria-labelledby="needs-attention-title"><h2 id="needs-attention-title">Needs attention</h2><div class="attention-list">${buttons}</div></section>`;
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
        } })
    ].filter(Boolean);
    window.gymPulseCharts = charts;
}
