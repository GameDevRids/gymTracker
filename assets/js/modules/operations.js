import { renderAccountSettings, renderDeleteGymSettings, renderSupportSettings } from "./account.js";
import { escapeHTML, formatINR, formatDate, formatPhone, indiaISODate, addDays, daysBetween, visitDay } from "../utils.js";
import { state, memberBalance, getMember } from "../state.js";
import { emptyRow } from "../components/tables.js";
import { drawChartOrEmpty, hasNonZero } from "../components/charts.js";
import { getLanguage, t } from "../i18n.js";
import { renderWelcomeTemplateSettings } from "./welcomeUi.js";
import { renderReminderTemplateSettings } from "./expiryReminder.js";
import { methodLabel, paymentsPage, renderUpiTestQr } from "./upiPayments.js";
import { renderSkeletonList } from "../components/skeleton.js";
import { renderVisitsPage } from "./attendance.js";
import { renderAttendanceSettings } from "./checkinSettingsUi.js";
import { getCurrentMembership, planNameFor } from "./memberMemberships.js";
import { currentSummary, monthLabel } from "./summary.js";
import { renderLocalDataSettings } from "./localData.js";
import { renderLapsedPage } from "./lapsed.js";
import { renderRenewalSettings } from "./renewalSettingsUi.js";

const pageHeading = (title, description, actions = "") =>
    `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;

export function renderOperationsPage(view) {
    const renderers = {
        attendance: renderAttendance,
        payments: renderPayments,
        // The view id stays "renewals" (saved preferences); the page is Lapsed members now.
        renewals: renderLapsedPage,
        retention: renderRetention,
        analytics: renderAnalytics,
        reports: renderReports,
        notifications: renderNotifications,
        integrations: renderIntegrations,
        settings: renderSettings
    };
    return renderers[view]?.() || `<div class="empty-state">This page is not available.</div>`;
}

// Check-ins from the database.
function renderAttendance() {
    return renderVisitsPage();
}

// Payments recorded in the gym's database, newest first, each with its receipt.
function renderPayments() {
    // Every member's balance, from the database; until it loads, the members in memory.
    const summary = currentSummary().data;
    const pending = summary ? summary.outstanding_total : state.members.reduce((sum, member) => sum + memberBalance(member), 0);
    const actions = `<button class="button button-secondary" data-action="export-payments">↓ Export CSV</button><button class="button button-primary" data-action="record-payment">＋ Record payment</button>`;
    const page = paymentsPage;
    let content;
    if (page.status === "idle" || page.status === "loading") {
        content = `<section class="card skeleton-section">${renderSkeletonList({ count: 4, label: "Loading payments…" })}</section>`;
    } else if (page.status === "error") {
        content = `<div class="empty-state" role="alert"><p>${escapeHTML(page.message)}</p><button class="button button-secondary" data-action="retry-payments">Try again</button></div>`;
    } else {
        content = `<section class="card table-card"><div class="table-wrap"><table class="payments-table"><thead><tr><th>Receipt</th><th>Member</th><th>Date</th><th>Method</th><th>Amount</th><th>UTR</th><th></th></tr></thead><tbody>${page.payments.length
            ? page.payments.map((payment) => `<tr data-payment-row data-method="${escapeHTML(methodLabel(payment.method))}" data-date="${escapeHTML(payment.paid_on)}"><td data-label="Receipt">${escapeHTML(payment.receipt_number || "—")}</td><td data-label="Member"><span>${escapeHTML(payment.member?.full_name || "Removed member")}<small class="cell-sub">${escapeHTML(payment.member?.member_code || "")}</small></span></td><td data-label="Date">${formatDate(payment.paid_on)}</td><td data-label="Method">${escapeHTML(methodLabel(payment.method))}</td><td data-label="Amount">${formatINR(payment.amount)}${payment.kind === "hold_fee" ? `<small class="cell-sub">Hold fee${payment.refunded_at ? " · refunded" : ""}</small>` : ""}</td><td data-label="UTR">${escapeHTML(payment.upi_reference || "—")}</td><td data-label="Receipt card"><button class="button button-secondary button-small" data-action="receipt" data-id="${escapeHTML(payment.id)}">Receipt</button></td></tr>`).join("")
            : emptyRow(7, "No payments recorded yet. Use Record payment to add the first one.")}</tbody></table></div></section>`;
    }
    const shown = page.total > page.payments.length ? ` <span class="helper-text">Showing the latest ${page.payments.length} of ${page.total}.</span>` : "";
    return `${pageHeading("Payments", "Record collections and share receipts.", actions)}
        <div class="summary-row"><span class="summary-chip"><strong>${formatINR(page.monthTotal)}</strong> collected this month</span><span class="summary-chip"><strong>${formatINR(pending)}</strong> outstanding</span><span class="summary-chip"><strong>${page.total}</strong> payments</span></div>
        <div class="toolbar"><input class="search-field" id="payment-search" type="search" placeholder="Search receipts, members or UTR…" aria-label="Search payments"><select class="field-control" id="payment-method-filter" aria-label="Filter by payment method"><option value="all">All methods</option>${["UPI", "Cash", "Card", "Other"].map((method) => `<option>${method}</option>`).join("")}</select><input class="field-control" id="payment-date-filter" type="date" aria-label="Filter payments by date"></div>
        ${content}${shown}
        <div class="note-box" style="margin-top:13px">GymPulse has no payment gateway and can't see your bank. Staff confirm each payment has arrived before marking it paid.</div>`;
}

const memberExpiry = (member) => getCurrentMembership(member.id)?.end_date || member.expiryDate || "";

// Each member's check-in days (India time), newest first.
function visitDaysByMember() {
    const days = new Map();
    for (const record of state.attendance) {
        const list = days.get(record.memberId) || [];
        list.push(visitDay(record));
        days.set(record.memberId, list);
    }
    for (const list of days.values()) list.sort((a, b) => b.localeCompare(a));
    return days;
}

export function retentionRows() {
    const today = indiaISODate();
    const visitsByMember = visitDaysByMember();
    return state.members.map((member) => {
        const visits = visitsByMember.get(member.id) || [];
        const lastVisit = visits[0];
        const days = lastVisit ? daysBetween(lastVisit, today) : null;
        const expiry = memberExpiry(member);
        const expiryDays = expiry ? daysBetween(today, expiry) : null;
        const recentVisits = visits.filter((day) => daysBetween(day, today) <= 14).length;
        const priorVisits = visits.filter((day) => daysBetween(day, today) > 14 && daysBetween(day, today) <= 28).length;
        const reasons = [];
        if (days === null || days >= 30) reasons.push("No visit in 30+ days");
        else if (days >= 14) reasons.push("No visit in 14+ days");
        else if (days >= 7) reasons.push("No visit in 7+ days");
        if (expiryDays !== null && expiryDays <= 7 && expiryDays >= 0) reasons.push("Membership expiring soon");
        if (expiryDays !== null && expiryDays < 0) reasons.push("Expired without renewal");
        if (priorVisits > 0 && recentVisits < priorVisits) reasons.push("Attendance declining");
        return { member, lastVisit, days, expiryDays, reasons };
    }).filter((row) => row.reasons.length);
}

function renderRetention() {
    const rows = retentionRows();
    return `${pageHeading("Retention assistant", "Rule-based follow-up suggestions. These are not churn predictions.", `<button class="button button-secondary" data-action="export-retention">↓ Export CSV</button>`)}
        <div class="note-box" style="margin-bottom:14px">Use these signals as helpful reminders, not certainty about a member's intentions. Mark each follow-up as you contact the member.</div>
        <div class="summary-row"><span class="summary-chip"><strong>${rows.length}</strong> members to follow up</span><span class="summary-chip"><strong>${rows.filter((row) => row.reasons.some((reason) => reason.includes("expir"))).length}</strong> expiry reminders</span></div>
        <section class="card table-card"><div class="table-wrap"><table><thead><tr><th>Member</th><th>Last visit</th><th>Days inactive</th><th>Expiry</th><th>Follow-up reason</th><th>Suggested action</th><th>Status</th></tr></thead><tbody>${rows.length ? rows.map(({ member, lastVisit, days, reasons }) => `<tr><td>${escapeHTML(member.name)}</td><td>${formatDate(lastVisit)}</td><td>${days === null ? "No visits" : days}</td><td>${formatDate(memberExpiry(member))}</td><td>${escapeHTML(reasons.join(" · "))}</td><td>${days === null || days >= 14 ? "Send a friendly check-in" : "Ask how training is going"}</td><td><select class="field-control followup-select" data-id="${escapeHTML(member.id)}" aria-label="Follow-up status for ${escapeHTML(member.name)}">${["pending", "contacted", "returned", "renewed", "not interested"].map((status) => `<option value="${status}" ${(member.followUpStatus || "pending") === status ? "selected" : ""}>${status[0].toUpperCase() + status.slice(1)}</option>`).join("")}</select></td></tr>`).join("") : emptyRow(7, "No members currently match the follow-up rules.")}</tbody></table></div></section>`;
}

// Totals from the database (every member and payment), check-ins from the last 60 days.
function renderAnalytics() {
    const heading = pageHeading("Analytics", "A clearer view of your gym's performance.", `<button class="button button-secondary" data-action="export-analytics">↓ Export summary</button>`);
    const { status, data: summary, message } = currentSummary();
    if (!summary) {
        return status === "error"
            ? `${heading}<div class="empty-state" role="alert"><p>${escapeHTML(message)}</p><button class="button button-secondary" data-action="retry-summary">Try again</button></div>`
            : `${heading}<section class="card skeleton-section">${renderSkeletonList({ count: 4, label: "Loading analytics…", variant: "card" })}</section>`;
    }
    const today = indiaISODate();
    const recentAttendance = state.attendance.filter((record) => visitDay(record) > addDays(today, -30)).length;
    const avgRevenue = summary.total_members ? Math.round(summary.collected_all_time / summary.total_members) : 0;
    const renewalRate = summary.due_last_30_days ? Math.round(summary.renewed_last_30_days / summary.due_last_30_days * 100) : 0;
    const empty = !summary.total_members && !summary.collected_all_time && !state.attendance.length;
    return `${heading}
        ${empty ? `<div class="note-box" role="status" style="margin-bottom:14px">No data yet. Analytics will fill in as you add members, record payments and log check-ins.</div>` : ""}
        <div class="grid kpi-grid">
            ${metric("Active members", summary.active_members, `${summary.total_members - summary.active_members} without a current plan`)}
            ${metric("New members", summary.new_members_this_month, "Joined this month")}
            ${metric("Renewals", summary.renewals_this_month, "Recorded this month")}
            ${metric("Renewal rate", summary.due_last_30_days ? `${renewalRate}%` : "—", `${summary.renewed_last_30_days} of ${summary.due_last_30_days} members whose plan ended in the last 30 days`)}
            ${metric("Avg. revenue per member", formatINR(avgRevenue), "All-time collected / current members")}
            ${metric("Outstanding balance", formatINR(summary.outstanding_total), "Billed fees less payments, all members")}
            ${metric("Attendance frequency", `${recentAttendance} visits`, "Recorded during last 30 days")}
        </div>
        <div class="grid content-grid">
            <section class="card"><div class="card-header"><div><h2>Monthly revenue</h2><p>Actual collected payments, by calendar month</p></div></div><div class="chart-area"><canvas id="analytics-revenue" aria-label="Monthly revenue chart"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
            <section class="card"><div class="card-header"><div><h2>Plan popularity</h2><p>Members with a current plan, by plan</p></div></div><div class="chart-area"><canvas id="plan-chart" aria-label="Membership plan distribution"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
        </div>
        <div class="grid content-grid" style="margin-top:15px">
            <section class="card"><div class="card-header"><div><h2>Daily attendance</h2><p>Check-ins recorded each day · last 7 days</p></div></div><div class="chart-area"><canvas id="analytics-attendance" aria-label="Daily attendance chart"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
            <section class="card"><div class="card-header"><div><h2>Outstanding balance trend</h2><p>Estimated unpaid fees at each month end</p></div></div><div class="chart-area"><canvas id="outstanding-chart" aria-label="Outstanding payment trend"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
        </div>
        <section class="card"><div class="card-header"><div><h2>Attendance insights</h2><p>Common check-in times from recorded visits</p></div></div><div class="card-body"><div class="summary-row">${[6, 9, 12, 17, 20].map((hour) => {
            const count = state.attendance.filter((record) => indiaHour(record.checkedInAt) === hour).length;
            return `<span class="summary-chip"><strong>${hour}:00</strong> · ${count} visits</span>`;
        }).join("")}</div><p class="helper-text">Peak hours are estimated from check-ins in the last 60 days (India time). The renewal rate counts a member as renewed when they have a later plan.</p></div></section>`;
}

function indiaHour(value) {
    const time = new Date(value);
    return Number.isNaN(time.getTime()) ? -1 : Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(time));
}

function metric(title, value, note) {
    return `<article class="card kpi-card"><div class="kpi-top">${title}</div><div class="kpi-value">${value}</div><div class="kpi-foot">${note}</div></article>`;
}

export function drawAnalyticsCharts() {
    const summary = currentSummary().data;
    if (!summary) return;
    if (!window.Chart) {
        document.querySelectorAll(".chart-fallback").forEach((item) => { item.hidden = false; });
        return;
    }
    window.gymPulseCharts?.forEach((chart) => chart.destroy());
    const months = summary.months || [];
    const today = indiaISODate();
    const attendanceDays = Array.from({ length: 7 }, (_, index) => {
        const key = addDays(today, index - 6);
        return {
            label: new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(new Date(`${key}T12:00:00`)),
            value: state.attendance.filter((record) => visitDay(record) === key).length
        };
    });
    const plans = summary.active_by_plan || [];
    const charts = [
        drawChartOrEmpty(document.querySelector("#analytics-revenue"), { hasData: hasNonZero(months.map((item) => item.collected)), emptyMessage: "No payments recorded in the last 6 months.", config: {
        type: "line", data: { labels: months.map((item) => monthLabel(item.month)), datasets: [{ data: months.map((item) => item.collected), borderColor: "#4b8b59", backgroundColor: "rgba(110,166,100,.12)", fill: true, tension: .35 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => formatINR(context.raw) } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: "#eef1ed" }, ticks: { callback: (value) => formatINR(value) } } } }
    } }),
        drawChartOrEmpty(document.querySelector("#plan-chart"), { hasData: plans.length > 0, emptyMessage: "No members on a plan yet.", config: {
        type: "doughnut", data: { labels: plans.map((row) => row.plan_name), datasets: [{ data: plans.map((row) => row.members), backgroundColor: ["#326a48", "#8db876", "#c4dc86", "#d9a966", "#b8c5ba"], borderWidth: 0 }] },
        options: { maintainAspectRatio: false, cutout: "66%", plugins: { legend: { position: "bottom", labels: { boxWidth: 8, usePointStyle: true, font: { size: 9 } } } } }
    } }),
        drawChartOrEmpty(document.querySelector("#analytics-attendance"), { hasData: hasNonZero(attendanceDays.map((item) => item.value)), emptyMessage: "No visits recorded in the last 7 days.", config: {
        type: "bar",
        data: { labels: attendanceDays.map((item) => item.label), datasets: [{ data: attendanceDays.map((item) => item.value), backgroundColor: "#8fbd7e", borderRadius: 5, maxBarThickness: 26 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#eef1ed" } } } }
    } }),
        drawChartOrEmpty(document.querySelector("#outstanding-chart"), { hasData: hasNonZero(months.map((item) => item.outstanding)), emptyMessage: "No outstanding balances to show.", config: {
        type: "line",
        data: { labels: months.map((item) => monthLabel(item.month)), datasets: [{ data: months.map((item) => item.outstanding), borderColor: "#c58255", backgroundColor: "rgba(197,130,85,.12)", fill: true, tension: .35 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => formatINR(context.raw) } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: "#eef1ed" }, ticks: { callback: (value) => formatINR(value) } } } }
    } })
    ].filter(Boolean);
    window.gymPulseCharts = charts;
}

function renderReports() {
    return `${pageHeading("Reports", "Choose a report and download the latest data as CSV.", `<button class="button button-secondary" data-action="download-report">↓ Download CSV</button>`)}
        <section class="card settings-section"><h2>Generate a report</h2><div class="form-grid"><div class="field"><label for="report-type">Report type</label><select id="report-type"><option value="attendance-daily">Daily attendance</option><option value="attendance-monthly">Monthly attendance</option><option value="revenue">Revenue transactions</option><option value="outstanding">Outstanding payments</option><option value="memberships">Memberships</option><option value="renewals">Renewal history</option><option value="inactive">Inactive members</option></select></div><div class="field"><label for="report-date">Date (for daily report)</label><input id="report-date" type="date" value="${indiaISODate()}" max="${indiaISODate()}"></div></div><p class="helper-text" style="margin-top:12px">Reports are made from your gym's database and downloaded to this device. They open in Excel or Google Sheets.</p></section>
        <section class="card"><div class="card-header"><div><h2>Available reports</h2><p>Exports open in spreadsheet software such as Excel.</p></div></div><div class="card-body"><div class="grid detail-grid">${[
            ["Daily attendance", "Check-in and member details for a selected date."],
            ["Monthly attendance", "Visit history in the current calendar month."],
            ["Revenue", "Every payment recorded, with receipt numbers."],
            ["Outstanding payments", "Member balances due after recorded payments."],
            ["Memberships", "Each member's current plan and status."],
            ["Renewal history", "Every plan after a member's first one."],
            ["Inactive members", "Members with no visit in 14 days or more."]
        ].map(([title, detail]) => `<article class="card detail-card"><span>${escapeHTML(title)}</span><strong class="detail-card-text">${escapeHTML(detail)}</strong></article>`).join("")}</div></div></section>`;
}

// Latest payments for the previews, from the database's Payments list.
function latestPayments() {
    return paymentsPage.payments.map((payment) => ({ memberId: payment.member_id, amount: payment.amount, date: payment.paid_on, reference: payment.receipt_number }));
}

function notifications() {
    const list = [];
    const today = indiaISODate();
    const preferences = gymPreferences();
    const visitsByMember = visitDaysByMember();
    state.members.forEach((member) => {
        const expiry = memberExpiry(member);
        const days = expiry ? daysBetween(today, expiry) : null;
        const due = memberBalance(member);
        const lastVisit = (visitsByMember.get(member.id) || [])[0];
        const inactiveDays = lastVisit ? daysBetween(lastVisit, today) : null;
        const plan = planNameFor(member);
        if (preferences.expiryReminderDays !== 0 && days !== null && days >= 0 && days <= preferences.expiryReminderDays) list.push({ type: "Membership expiry", member, message: `Hi ${member.name.split(" ")[0]}, your ${plan || "gym"} membership is due to expire on ${formatDate(expiry)}. Reply to learn about renewal options.` });
        if (preferences.paymentReminders && due > 0) list.push({ type: "Payment due", member, message: `Hi ${member.name.split(" ")[0]}, a balance of ${formatINR(due)} remains on your membership. Please contact the gym if you have any questions.` });
        if (preferences.inactivityReminders && (inactiveDays === null || inactiveDays >= 14)) list.push({ type: "Inactive member", member, message: `Hi ${member.name.split(" ")[0]}, we haven't seen you at the gym recently. We hope you are doing well and would love to see you back.` });
    });
    state.members.filter((member) => member.joinedAt && daysBetween(member.joinedAt, today) >= 0 && daysBetween(member.joinedAt, today) <= 7).forEach((member) => {
        list.push({ type: "New membership", member, message: `Welcome to ${state.gym.name}, ${member.name.split(" ")[0]}! Your ${planNameFor(member) || "membership"} is active through ${formatDate(memberExpiry(member))}. We look forward to seeing you.` });
    });
    [...state.attendance].sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt)).slice(0, 3).forEach((record) => {
        list.push({ type: "Attendance alert", member: getMember(record.memberId), message: `Attendance was recorded on ${formatDate(visitDay(record))}.` });
    });
    latestPayments().slice(0, 4).forEach((payment) => {
        list.push({ type: "Successful payment", member: getMember(payment.memberId), message: `Payment of ${formatINR(payment.amount)} was recorded on ${formatDate(payment.date)}.${payment.reference ? ` Receipt ${payment.reference}.` : ""}` });
    });
    return list.slice(0, 18);
}

function renderNotifications() {
    const items = notifications();
    const types = ["Membership expiry", "Payment due", "Inactive member", "Successful payment", "New membership", "Attendance alert"];
    return `${pageHeading("Notifications", "Review reminders and preview member messages.", `<span class="badge-soft">Preview only · not sent</span>`)}
        <div class="note-box" style="margin-bottom:14px">These messages are drafts for review only; nothing is sent from this page. Send expiry reminders on WhatsApp from Expiring soon.</div>
        <div class="summary-row">${types.map((type) => `<span class="summary-chip">${escapeHTML(type)}</span>`).join("")}</div>
        <div class="grid notification-grid">${items.length ? items.map((item) => `<article class="card notification-card"><div style="display:flex;justify-content:space-between;gap:8px"><h3>${escapeHTML(item.type)}</h3><span class="badge-soft">Preview</span></div><p>${escapeHTML(item.member?.name || "Member")}${item.member?.phone ? ` · ${escapeHTML(formatPhone(item.member.phone))}` : ""}</p><div class="note-box">${escapeHTML(item.message)}</div><button class="text-button" data-action="copy-message" data-message="${escapeHTML(item.message)}" style="margin-top:9px">Copy preview text</button></article>`).join("") : `<div class="card empty-state">No notification previews are available.</div>`}</div>`;
}

function renderIntegrations() {
    const integrations = [
        ["Check-in", "Member QR cards scanned by staff, or a QR poster members scan with their phone. Choose one in Settings › Attendance.", "Built in", "scan"],
        ["WhatsApp", "Welcome messages and expiry reminders open in WhatsApp with the message filled in, for members who agreed.", "Built in", ""],
        ["Member import", "Bring in members from Excel (.xlsx) or CSV: match your columns, check a preview, then save them all at once. Gym owners only.", "Available", "import-csv"],
        ["Gym management software", "External system APIs are not connected.", "Coming soon", ""],
        ["Payment gateways", "Record manual payments; no gateway is connected.", "Not connected", ""]
    ];
    return `${pageHeading("Integrations", "Connect GymPulse to your gym's existing workflows over time.")}
        <div class="note-box" style="margin-bottom:15px">This prototype does not connect to external systems. Check with each vendor for official API or SDK availability for your specific product and device model.</div>
        <div class="grid integration-grid">${integrations.map(([name, description, status, action]) => `<article class="card integration-card"><div style="display:flex;justify-content:space-between;gap:8px"><h3>${escapeHTML(name)}</h3><span class="badge-soft">${escapeHTML(status)}</span></div><p>${escapeHTML(description)}</p>${action ? `<button class="button button-secondary button-small" ${action === "scan" ? `data-view="scan"` : `data-action="${action}"`}>${action === "scan" ? "Open check-in" : "Import members"}</button>` : ""}</article>`).join("")}</div>`;
}

/** The gym's preferences (saved in the database; Settings), with defaults. */
export function gymPreferences() {
    const saved = state.gym.preferences || {};
    return {
        expiryReminderDays: Number.isInteger(saved.expiryReminderDays) ? saved.expiryReminderDays : 7,
        paymentReminders: saved.paymentReminders !== false,
        inactivityReminders: saved.inactivityReminders !== false
    };
}

function renderSettings() {
    const gym = state.gym;
    const preferences = gymPreferences();
    const language = getLanguage();
    return `${pageHeading("Settings", "Your gym's details and preferences, saved for every device.")}
        <div class="settings-layout"><div>${renderLocalDataSettings()}<section class="card settings-section"><h2>Gym profile</h2><form id="settings-form" class="form-grid">
            ${field("Gym name", "name", gym.name, "text", true)}${field("Phone number", "phone", gym.phone, "tel")}
            ${field("Address", "address", gym.address, "text", false, true)}
            <div class="field"><label for="setting-upiId">UPI ID</label><input id="setting-upiId" name="upiId" type="text" value="${escapeHTML(gym.upiId || "")}" placeholder="powergym@okicici" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="email" maxlength="320" aria-describedby="setting-upiId-help setting-upiId-error"><span class="helper-text" id="setting-upiId-help">Members pay to this ID by scanning the payment QR.</span><span class="helper-text field-error" id="setting-upiId-error" role="alert" hidden></span></div>
            <div class="field"><label for="setting-upiPayeeName">Name shown to payers</label><input id="setting-upiPayeeName" name="upiPayeeName" type="text" value="${escapeHTML(gym.upiPayeeName || "")}" placeholder="${escapeHTML(gym.name || "Gym name")}" maxlength="100"><span class="helper-text">Shown in the member's UPI app. Leave empty to use the gym name.</span></div>
            <div class="field full" id="upi-test-qr" aria-live="polite">${gym.upiId ? renderUpiTestQr(gym.upiId, gym.upiPayeeName) : `<p class="helper-text">Enter your UPI ID to see a ₹1 test QR.</p>`}</div>
            <div class="field"><label for="setting-language">${t("language")}</label><select id="setting-language" name="language"><option value="en" ${language === "en" ? "selected" : ""}>${t("english")}</option><option value="hi" ${language === "hi" ? "selected" : ""}>${t("hindi")}</option><option value="mr" ${language === "mr" ? "selected" : ""}>${t("marathi")}</option></select><span class="helper-text">For the app's menus and the WhatsApp messages you send.</span></div>
            <div class="field"><label for="dateFormat">Date format</label><select name="dateFormat" id="dateFormat"><option ${gym.dateFormat !== "DD/MM/YYYY" ? "selected" : ""}>DD MMM YYYY</option><option ${gym.dateFormat === "DD/MM/YYYY" ? "selected" : ""}>DD/MM/YYYY</option></select></div>
            <div class="field"><label for="expiryReminderDays">Expiry reminder window (days)</label><input id="expiryReminderDays" name="expiryReminderDays" type="number" min="0" max="90" value="${preferences.expiryReminderDays}"></div>
            <div class="field full"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="paymentReminders" ${preferences.paymentReminders ? "checked" : ""}> Preview payment-due reminders</label></div>
            <div class="field full"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="inactivityReminders" ${preferences.inactivityReminders ? "checked" : ""}> Preview inactive-member reminders</label></div>
            <div class="field full"><button class="button button-primary" type="submit">Save settings</button></div>
        </form></section>
        ${renderAttendanceSettings()}
        ${renderRenewalSettings()}
        ${renderWelcomeTemplateSettings()}
        ${renderReminderTemplateSettings()}
        ${renderAccountSettings()}
        ${renderSupportSettings()}
        <section class="card settings-section"><h2>Membership preferences</h2><p class="helper-text">Membership expiry is evaluated by calendar date. Renewals start the day after the current plan ends when it is still valid.</p></section>
        ${renderDeleteGymSettings()}</div>
        </div>`;
}

function field(label, name, value, type = "text", required = false, full = false) {
    return `<div class="field ${full ? "full" : ""}"><label for="setting-${name}">${escapeHTML(label)}</label><input id="setting-${name}" name="${name}" type="${type}" value="${escapeHTML(value || "")}" ${required ? "required" : ""}></div>`;
}
