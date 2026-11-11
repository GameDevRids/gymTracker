import { escapeHTML, formatINR, formatDate, formatPhone, localISODate, daysBetween, memberStatus, statusPill, monthKey } from "../utils.js";
import { state, memberBalance, getPlan, getMember, revenueEmptyMessage } from "../state.js";
import { emptyRow, memberTableRow } from "../components/tables.js";
import { drawChartOrEmpty, hasNonZero } from "../components/charts.js";
import { getLanguage, t } from "../i18n.js";

const pageHeading = (title, description, actions = "") =>
    `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;

export function renderOperationsPage(view) {
    const renderers = {
        attendance: renderAttendance,
        payments: renderPayments,
        renewals: renderRenewals,
        retention: renderRetention,
        analytics: renderAnalytics,
        reports: renderReports,
        notifications: renderNotifications,
        integrations: renderIntegrations,
        settings: renderSettings
    };
    return renderers[view]?.() || `<div class="empty-state">This page is not available.</div>`;
}

function renderAttendance() {
    const today = localISODate();
    const rows = [...state.attendance].sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt));
    const todayCount = rows.filter((record) => record.checkedInAt.slice(0, 10) === today).length;
    const weekCount = rows.filter((record) => daysBetween(record.checkedInAt.slice(0, 10)) < 7).length;
    const actions = `<button class="button button-primary" data-action="check-in">＋ Check in member</button>`;
    return `${pageHeading("Attendance", "Track check-ins and understand visit patterns.", actions)}
        <div class="summary-row"><span class="summary-chip"><strong>${todayCount}</strong> visits today</span><span class="summary-chip"><strong>${weekCount}</strong> visits this week</span><span class="summary-chip"><strong>${new Set(rows.filter((item) => daysBetween(item.checkedInAt.slice(0, 10)) < 30).map((item) => item.memberId)).size}</strong> unique visitors this month</span></div>
        <div class="toolbar"><input class="search-field" id="attendance-search" type="search" placeholder="Search member name or ID…" aria-label="Search attendance"></div>
        <section class="card table-card"><div class="table-wrap"><table><thead><tr><th>Member</th><th>Check-in</th><th>Check-out</th><th>Method</th><th>Membership</th><th>Action</th></tr></thead><tbody>${rows.length ? rows.map((record) => {
            const member = getMember(record.memberId);
            return `<tr data-attendance-row><td>${escapeHTML(member?.name || "Removed member")} <small class="helper-text">${escapeHTML(record.memberId)}</small></td><td>${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(record.checkedInAt))}</td><td>${record.checkedOutAt ? new Intl.DateTimeFormat("en-IN", { timeStyle: "short" }).format(new Date(record.checkedOutAt)) : "—"}</td><td>${escapeHTML(record.source)}</td><td>${member ? statusPill(memberStatus(member)) : statusPill("inactive")}</td><td>${member && !record.checkedOutAt ? `<button class="text-button" data-action="check-out" data-id="${escapeHTML(record.id)}">Check out</button>` : "—"}</td></tr>`;
        }).join("") : emptyRow(6, "No check-ins recorded yet.")}</tbody></table></div></section>
        <p class="helper-text" style="margin-top:11px">Duplicate check-ins on the same day are blocked. Expired memberships can still be recorded with a warning for staff review.</p>`;
}

function renderPayments() {
    const revenue = state.payments.filter((payment) => payment.status === "paid" && payment.date.slice(0, 7) === monthKey()).reduce((sum, payment) => sum + Number(payment.amount), 0);
    const pending = state.members.reduce((sum, member) => sum + memberBalance(member), 0);
    const actions = `<button class="button button-secondary" data-action="export-payments">↓ Export CSV</button><button class="button button-primary" data-action="record-payment">＋ Record payment</button>`;
    const payments = [...state.payments].sort((a, b) => b.date.localeCompare(a.date));
    return `${pageHeading("Payments", "Record collections and keep track of outstanding balances.", actions)}
        <div class="summary-row"><span class="summary-chip"><strong>${formatINR(revenue)}</strong> collected this month${state.sampleDataLoaded ? ` <span class="sample-data-badge">Sample data</span>` : ""}</span><span class="summary-chip"><strong>${formatINR(pending)}</strong> outstanding</span><span class="summary-chip"><strong>${payments.length}</strong> transactions</span></div>
        <div class="toolbar"><input class="search-field" id="payment-search" type="search" placeholder="Search transactions or members…" aria-label="Search payments"><select class="field-control" id="payment-method-filter" aria-label="Filter by payment method"><option value="all">All methods</option>${["UPI", "Cash", "Card", "Bank transfer", "Other"].map((method) => `<option>${method}</option>`).join("")}</select><input class="field-control" id="payment-date-filter" type="date" aria-label="Filter payments by date"></div>
        <section class="card table-card"><div class="table-wrap"><table><thead><tr><th>Transaction</th><th>Member</th><th>Date</th><th>Method</th><th>Amount</th><th>Status</th><th>Receipt</th></tr></thead><tbody>${payments.length ? payments.map((payment) => `<tr data-payment-row data-method="${escapeHTML(payment.method)}" data-date="${escapeHTML(payment.date)}"><td>${escapeHTML(payment.id)}</td><td>${escapeHTML(getMember(payment.memberId)?.name || "Removed member")}</td><td>${formatDate(payment.date)}</td><td>${escapeHTML(payment.method)}</td><td>${formatINR(payment.amount)}</td><td>${statusPill(payment.status)}</td><td><button class="text-button" data-action="receipt" data-id="${escapeHTML(payment.id)}">Preview</button></td></tr>`).join("") : emptyRow(7, "No payments recorded yet. Use Record payment to add the first one.")}</tbody></table></div></section>
        <div class="note-box" style="margin-top:13px">GymPulse records manual payments only. No payment gateway is connected. Outstanding balances are calculated from membership fees less successful recorded payments.</div>`;
}

function renderRenewals() {
    const today = localISODate();
    const members = [...state.members].map((member) => ({ member, days: daysBetween(today, member.expiryDate) }))
        .filter(({ days }) => days <= 30).sort((a, b) => a.days - b.days);
    const buckets = {
        expired: members.filter(({ days }) => days < 0).length,
        today: members.filter(({ days }) => days === 0).length,
        three: members.filter(({ days }) => days >= 1 && days <= 3).length,
        seven: members.filter(({ days }) => days >= 1 && days <= 7).length,
        thirty: members.filter(({ days }) => days >= 1 && days <= 30).length
    };
    return `${pageHeading("Renewals", "Stay ahead of upcoming expiries and keep memberships active.", `<button class="button button-secondary" data-action="export-renewals">↓ Export list</button>`)}
        <div class="summary-row"><span class="summary-chip"><strong>${buckets.expired}</strong> expired</span><span class="summary-chip"><strong>${buckets.today}</strong> expire today</span><span class="summary-chip"><strong>${buckets.three}</strong> within 3 days</span><span class="summary-chip"><strong>${buckets.seven}</strong> within 7 days</span><span class="summary-chip"><strong>${buckets.thirty}</strong> within 30 days</span></div>
        <div class="toolbar"><select class="field-control" id="renewal-filter"><option value="all">All due</option><option value="expired">Expired</option><option value="today">Today</option><option value="3">Within 3 days</option><option value="7">Within 7 days</option><option value="30">Within 30 days</option></select></div>
        <section class="card table-card"><div class="table-wrap"><table><thead><tr><th>Member</th><th>Phone</th><th>Plan</th><th>Expiry</th><th>Days</th><th>Balance</th><th>Action</th></tr></thead><tbody>${members.length ? members.map(({ member, days }) => `<tr data-renewal-row data-days="${days}"><td>${escapeHTML(member.name)}</td><td>${escapeHTML(formatPhone(member.phone))}</td><td>${escapeHTML(getPlan(member.planId)?.name || "—")}</td><td>${formatDate(member.expiryDate)}</td><td>${days < 0 ? `${Math.abs(days)} days ago` : days === 0 ? "Today" : `${days} days`}</td><td>${formatINR(memberBalance(member))}</td><td><button class="button button-secondary button-small" data-action="renew-member" data-id="${escapeHTML(member.id)}">Renew</button></td></tr>`).join("") : emptyRow(7, "No memberships due in this window.")}</tbody></table></div></section>`;
}

function retentionRows() {
    const today = localISODate();
    return state.members.map((member) => {
        const visits = state.attendance.filter((record) => record.memberId === member.id).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt));
        const lastVisit = visits[0]?.checkedInAt.slice(0, 10);
        const days = lastVisit ? daysBetween(lastVisit) : null;
        const expiryDays = daysBetween(today, member.expiryDate);
        const recentVisits = state.attendance.filter((record) => record.memberId === member.id && daysBetween(record.checkedInAt.slice(0, 10)) <= 14).length;
        const priorVisits = state.attendance.filter((record) => record.memberId === member.id && daysBetween(record.checkedInAt.slice(0, 10)) > 14 && daysBetween(record.checkedInAt.slice(0, 10)) <= 28).length;
        const reasons = [];
        if (days === null || days >= 30) reasons.push("No visit in 30+ days");
        else if (days >= 14) reasons.push("No visit in 14+ days");
        else if (days >= 7) reasons.push("No visit in 7+ days");
        if (expiryDays <= 7 && expiryDays >= 0) reasons.push("Membership expiring soon");
        if (expiryDays < 0) reasons.push("Expired without renewal");
        if (priorVisits > 0 && recentVisits < priorVisits) reasons.push("Attendance declining");
        return { member, lastVisit, days, expiryDays, reasons };
    }).filter((row) => row.reasons.length);
}

function renderRetention() {
    const rows = retentionRows();
    return `${pageHeading("Retention assistant", "Rule-based follow-up suggestions. These are not churn predictions.", `<button class="button button-secondary" data-action="export-retention">↓ Export CSV</button>`)}
        <div class="note-box" style="margin-bottom:14px">Use these signals as helpful reminders, not certainty about a member's intentions. Mark each follow-up as you contact the member.</div>
        <div class="summary-row"><span class="summary-chip"><strong>${rows.length}</strong> members to follow up</span><span class="summary-chip"><strong>${rows.filter((row) => row.reasons.some((reason) => reason.includes("expir"))).length}</strong> expiry reminders</span></div>
        <section class="card table-card"><div class="table-wrap"><table><thead><tr><th>Member</th><th>Last visit</th><th>Days inactive</th><th>Expiry</th><th>Follow-up reason</th><th>Suggested action</th><th>Status</th></tr></thead><tbody>${rows.length ? rows.map(({ member, lastVisit, days, reasons }) => `<tr><td>${escapeHTML(member.name)}</td><td>${formatDate(lastVisit)}</td><td>${days === null ? "No visits" : days}</td><td>${formatDate(member.expiryDate)}</td><td>${escapeHTML(reasons.join(" · "))}</td><td>${days === null || days >= 14 ? "Send a friendly check-in" : "Ask how training is going"}</td><td><select class="field-control followup-select" data-id="${escapeHTML(member.id)}" aria-label="Follow-up status for ${escapeHTML(member.name)}">${["pending", "contacted", "returned", "renewed", "not interested"].map((status) => `<option value="${status}" ${(member.followUpStatus || "pending") === status ? "selected" : ""}>${status[0].toUpperCase() + status.slice(1)}</option>`).join("")}</select></td></tr>`).join("") : emptyRow(7, "No members currently match the follow-up rules.")}</tbody></table></div></section>`;
}

function renderAnalytics() {
    const active = state.members.filter((member) => memberStatus(member) === "active");
    const revenue = state.payments.filter((payment) => payment.status === "paid").reduce((sum, payment) => sum + Number(payment.amount), 0);
    const outstanding = state.members.reduce((sum, member) => sum + memberBalance(member), 0);
    const recentAttendance = state.attendance.filter((record) => daysBetween(record.checkedInAt.slice(0, 10)) < 30).length;
    const avgRevenue = state.members.length ? Math.round(revenue / state.members.length) : 0;
    const currentMonth = monthKey();
    const newMembers = state.members.filter((member) => member.joinedAt.slice(0, 7) === currentMonth).length;
    const renewalsThisMonth = state.members.flatMap((member) => member.renewals || []).filter((renewal) => renewal.date.slice(0, 7) === currentMonth).length;
    const periodStartDate = new Date();
    periodStartDate.setDate(periodStartDate.getDate() - 30);
    const periodStart = localISODate(periodStartDate);
    const today = localISODate();
    const dueMembers = new Set();
    const renewedMembers = new Set();
    state.members.forEach((member) => {
        if (member.expiryDate >= periodStart && member.expiryDate <= today) dueMembers.add(member.id);
        (member.renewals || []).forEach((renewal) => {
            if (renewal.previousExpiryDate >= periodStart && renewal.previousExpiryDate <= today) dueMembers.add(member.id);
            if (renewal.date >= periodStart && renewal.date <= today) {
                dueMembers.add(member.id);
                renewedMembers.add(member.id);
            }
        });
    });
    const renewalRate = dueMembers.size ? Math.round(renewedMembers.size / dueMembers.size * 100) : 0;
    return `${pageHeading("Analytics", "A clearer view of your gym's performance.", `<button class="button button-secondary" data-action="export-analytics">↓ Export summary</button>`)}
        ${!state.members.length && !state.payments.length && !state.attendance.length ? `<div class="note-box" role="status" style="margin-bottom:14px">No data yet. Analytics will fill in as you add members, record payments and log check-ins.</div>` : ""}
        <div class="grid kpi-grid">
            ${metric("Active members", active.length, `${state.members.length - active.length} expired or suspended`)}
            ${metric("New memberships", newMembers, "Joined this month")}
            ${metric("Renewals", renewalsThisMonth, "Recorded this month")}
            ${metric("Renewal rate", `${renewalRate}%`, "Renewed / due members · last 30 days")}
            ${metric("Avg. revenue per member", formatINR(avgRevenue), "All-time collected / members")}
            ${metric("Outstanding balance", formatINR(outstanding), "Current billed fees less collections")}
            ${metric("Attendance frequency", `${recentAttendance} visits`, "Recorded during last 30 days")}
        </div>
        <div class="grid content-grid">
            <section class="card"><div class="card-header"><div><h2>Monthly revenue</h2><p>Actual collected payments, by calendar month</p></div></div><div class="chart-area"><canvas id="analytics-revenue" aria-label="Monthly revenue chart"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
            <section class="card"><div class="card-header"><div><h2>Plan popularity</h2><p>Members enrolled by plan</p></div></div><div class="chart-area"><canvas id="plan-chart" aria-label="Membership plan distribution"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
        </div>
        <div class="grid content-grid" style="margin-top:15px">
            <section class="card"><div class="card-header"><div><h2>Daily attendance</h2><p>Check-ins recorded each day · last 7 days</p></div></div><div class="chart-area"><canvas id="analytics-attendance" aria-label="Daily attendance chart"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
            <section class="card"><div class="card-header"><div><h2>Outstanding balance trend</h2><p>Estimated unpaid billed fees at each month end</p></div></div><div class="chart-area"><canvas id="outstanding-chart" aria-label="Outstanding payment trend"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
        </div>
        <section class="card"><div class="card-header"><div><h2>Attendance insights</h2><p>Common check-in times from recorded visits</p></div></div><div class="card-body"><div class="summary-row">${[6, 9, 12, 17, 20].map((hour) => {
            const count = state.attendance.filter((record) => new Date(record.checkedInAt).getHours() === hour).length;
            return `<span class="summary-chip"><strong>${hour}:00</strong> · ${count} visits</span>`;
        }).join("")}</div><p class="helper-text">Peak hours are estimated from recorded check-ins. Renewal rate uses recorded renewals and the current due-member count, so it is directional.</p></div></section>`;
}

function metric(title, value, note) {
    return `<article class="card kpi-card"><div class="kpi-top">${title}</div><div class="kpi-value">${value}</div><div class="kpi-foot">${note}</div></article>`;
}

export function drawAnalyticsCharts() {
    if (!window.Chart) {
        document.querySelectorAll(".chart-fallback").forEach((item) => { item.hidden = false; });
        return;
    }
    window.gymPulseCharts?.forEach((chart) => chart.destroy());
    const monthDates = Array.from({ length: 6 }, (_, index) => {
        const date = new Date();
        date.setDate(1);
        date.setMonth(date.getMonth() - (5 - index));
        const month = monthKey(date);
        return {
            label: new Intl.DateTimeFormat("en-IN", { month: "short" }).format(date),
            value: state.payments.filter((payment) => payment.status === "paid" && payment.date.slice(0, 7) === month).reduce((sum, payment) => sum + Number(payment.amount), 0)
        };
    });
    const attendanceDays = Array.from({ length: 7 }, (_, index) => {
        const date = new Date();
        date.setDate(date.getDate() - (6 - index));
        const key = localISODate(date);
        return {
            label: new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(date),
            value: state.attendance.filter((record) => record.checkedInAt.slice(0, 10) === key).length
        };
    });
    const outstandingMonths = Array.from({ length: 6 }, (_, index) => {
        const date = new Date();
        date.setDate(1);
        date.setMonth(date.getMonth() - (5 - index));
        const monthEnd = localISODate(new Date(date.getFullYear(), date.getMonth() + 1, 0));
        const totalBilled = state.members.reduce((sum, member) => {
            const charges = member.charges?.length ? member.charges : [{ amount: member.totalFees, date: member.startDate }];
            return sum + charges.filter((charge) => charge.date <= monthEnd).reduce((chargeTotal, charge) => chargeTotal + Number(charge.amount || 0), 0);
        }, 0);
        const collected = state.payments.filter((payment) => payment.status === "paid" && payment.date <= monthEnd).reduce((sum, payment) => sum + Number(payment.amount), 0);
        return {
            label: new Intl.DateTimeFormat("en-IN", { month: "short" }).format(date),
            value: Math.max(0, totalBilled - collected)
        };
    });
    const planCounts = state.plans.map((plan) => state.members.filter((member) => member.planId === plan.id).length);
    const charts = [
        drawChartOrEmpty(document.querySelector("#analytics-revenue"), { hasData: hasNonZero(monthDates.map((item) => item.value)), emptyMessage: revenueEmptyMessage(), config: {
        type: "line", data: { labels: monthDates.map((item) => item.label), datasets: [{ data: monthDates.map((item) => item.value), borderColor: "#4b8b59", backgroundColor: "rgba(110,166,100,.12)", fill: true, tension: .35 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: "#eef1ed" } } } }
    } }),
        drawChartOrEmpty(document.querySelector("#plan-chart"), { hasData: hasNonZero(planCounts), emptyMessage: "No members on a plan yet.", config: {
        type: "doughnut", data: { labels: state.plans.map((plan) => plan.name), datasets: [{ data: planCounts, backgroundColor: ["#326a48", "#8db876", "#c4dc86", "#d9a966", "#b8c5ba"], borderWidth: 0 }] },
        options: { maintainAspectRatio: false, cutout: "66%", plugins: { legend: { position: "bottom", labels: { boxWidth: 8, usePointStyle: true, font: { size: 9 } } } } }
    } }),
        drawChartOrEmpty(document.querySelector("#analytics-attendance"), { hasData: hasNonZero(attendanceDays.map((item) => item.value)), emptyMessage: "No visits recorded in the last 7 days.", config: {
        type: "bar",
        data: { labels: attendanceDays.map((item) => item.label), datasets: [{ data: attendanceDays.map((item) => item.value), backgroundColor: "#8fbd7e", borderRadius: 5, maxBarThickness: 26 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#eef1ed" } } } }
    } }),
        drawChartOrEmpty(document.querySelector("#outstanding-chart"), { hasData: hasNonZero(outstandingMonths.map((item) => item.value)), emptyMessage: "No outstanding balances to show.", config: {
        type: "line",
        data: { labels: outstandingMonths.map((item) => item.label), datasets: [{ data: outstandingMonths.map((item) => item.value), borderColor: "#c58255", backgroundColor: "rgba(197,130,85,.12)", fill: true, tension: .35 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => formatINR(context.raw) } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: "#eef1ed" }, ticks: { callback: (value) => formatINR(value) } } } }
    } })
    ].filter(Boolean);
    window.gymPulseCharts = charts;
}

function renderReports() {
    return `${pageHeading("Reports", "Choose a report and download the latest data as CSV.", `<button class="button button-secondary" data-action="download-report">↓ Download CSV</button>`)}
        <section class="card settings-section"><h2>Generate a report</h2><div class="form-grid"><div class="field"><label for="report-type">Report type</label><select id="report-type"><option value="attendance-daily">Daily attendance</option><option value="attendance-monthly">Monthly attendance</option><option value="revenue">Revenue transactions</option><option value="outstanding">Outstanding payments</option><option value="memberships">Memberships</option><option value="renewals">Renewal history</option><option value="inactive">Inactive members</option></select></div><div class="field"><label for="report-date">Date (for daily report)</label><input id="report-date" type="date" value="${localISODate()}"></div></div><p class="helper-text" style="margin-top:12px">CSV reports are generated in your browser from the records currently loaded. The file is not uploaded anywhere.</p></section>
        <section class="card"><div class="card-header"><div><h2>Available reports</h2><p>Exports open in spreadsheet software such as Excel.</p></div></div><div class="card-body"><div class="grid detail-grid">${[
            ["Daily attendance", "Check-in and member details for a selected date."],
            ["Monthly attendance", "Visit history in the current calendar month."],
            ["Revenue", "Payments successfully collected, not billed fees."],
            ["Outstanding payments", "Member balances due after recorded payments."],
            ["Memberships", "Member plan and membership status details."],
            ["Inactive members", "Members matching 14+ day follow-up rules."]
        ].map(([title, detail]) => `<article class="card detail-card"><span>${escapeHTML(title)}</span><strong style="font:500 10px 'DM Sans',sans-serif;line-height:1.5">${escapeHTML(detail)}</strong></article>`).join("")}</div></div></section>`;
}

function notifications() {
    const list = [];
    state.members.forEach((member) => {
        const days = daysBetween(localISODate(), member.expiryDate);
        const due = memberBalance(member);
        const attendance = state.attendance.filter((record) => record.memberId === member.id).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt))[0];
        const inactiveDays = attendance ? daysBetween(attendance.checkedInAt.slice(0, 10)) : null;
        const preferences = state.gym.preferences || {};
        if (preferences.expiryReminderDays !== 0 && days >= 0 && days <= (preferences.expiryReminderDays || 7)) list.push({ type: "Membership expiry", member, message: `Hi ${member.name.split(" ")[0]}, your ${getPlan(member.planId)?.name || "gym"} membership is due to expire on ${formatDate(member.expiryDate)}. Reply to learn about renewal options.` });
        if (preferences.paymentReminders !== false && due > 0) list.push({ type: "Payment due", member, message: `Hi ${member.name.split(" ")[0]}, a balance of ${formatINR(due)} remains on your membership. Please contact the gym if you have any questions.` });
        if (preferences.inactivityReminders !== false && (inactiveDays === null || inactiveDays >= 14)) list.push({ type: "Inactive member", member, message: `Hi ${member.name.split(" ")[0]}, we haven't seen you at the gym recently. We hope you are doing well and would love to see you back.` });
    });
    state.members.filter((member) => daysBetween(member.joinedAt) >= 0 && daysBetween(member.joinedAt) <= 7).forEach((member) => {
        list.push({ type: "New membership", member, message: `Welcome to ${state.gym.name}, ${member.name.split(" ")[0]}! Your ${getPlan(member.planId)?.name || "membership"} is active through ${formatDate(member.expiryDate)}. We look forward to seeing you.` });
    });
    [...state.attendance].sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt)).slice(0, 3).forEach((record) => {
        list.push({ type: "Attendance alert", member: getMember(record.memberId), message: `Attendance was recorded on ${formatDate(record.checkedInAt)}. This local alert is a preview and has not been delivered.` });
    });
    [...state.payments].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4).forEach((payment) => {
        list.push({ type: "Successful payment", member: getMember(payment.memberId), message: `Payment of ${formatINR(payment.amount)} was recorded on ${formatDate(payment.date)}. Transaction reference: ${payment.id}.` });
    });
    return list.slice(0, 18);
}

function renderNotifications() {
    const items = notifications();
    const types = ["Membership expiry", "Payment due", "Inactive member", "Successful payment", "New membership", "Attendance alert"];
    return `${pageHeading("Notifications", "Review reminders and preview member messages.", `<span class="badge-soft">Preview only · not sent</span>`)}
        <div class="note-box" style="margin-bottom:14px">These messages are drafts for review only; nothing is sent from this page. Use the WhatsApp inbox for simulated Demo messages or configured Meta Live sends.</div>
        <div class="summary-row">${types.map((type) => `<span class="summary-chip">${escapeHTML(type)}</span>`).join("")}</div>
        <div class="grid notification-grid">${items.length ? items.map((item) => `<article class="card notification-card"><div style="display:flex;justify-content:space-between;gap:8px"><h3>${escapeHTML(item.type)}</h3><span class="badge-soft">Preview</span></div><p>${escapeHTML(item.member?.name || "Member")}${item.member?.phone ? ` · ${escapeHTML(formatPhone(item.member.phone))}` : ""}</p><div class="note-box">${escapeHTML(item.message)}</div><button class="text-button" data-action="copy-message" data-message="${escapeHTML(item.message)}" style="margin-top:9px">Copy preview text</button></article>`).join("") : `<div class="card empty-state">No notification previews are available.</div>`}</div>`;
}

function renderIntegrations() {
    const integrations = [
        ["Biometric devices", "Simulated scan flow only. No hardware connection.", "Demo mode", "fingerprint"],
        ["WhatsApp Cloud API", "Demo inbox is ready; live mode uses the official Meta Cloud API.", "Open inbox", "whatsapp-inbox"],
        ["CSV imports", "Map a CSV export and preview records before importing.", "Available", "import-csv"],
        ["Gym management software", "External system APIs are not connected.", "Coming soon", ""],
        ["Payment gateways", "Record manual payments; no gateway is connected.", "Not connected", ""]
    ];
    return `${pageHeading("Integrations", "Connect GymPulse to your gym's existing workflows over time.")}
        <div class="note-box" style="margin-bottom:15px">This prototype does not connect to external systems. Check with each vendor for official API or SDK availability for your specific product and device model.</div>
        <div class="grid integration-grid">${integrations.map(([name, description, status, action]) => `<article class="card integration-card"><div style="display:flex;justify-content:space-between;gap:8px"><h3>${escapeHTML(name)}</h3><span class="badge-soft">${escapeHTML(status)}</span></div><p>${escapeHTML(description)}</p>${action ? `<button class="button button-secondary button-small" ${action === "whatsapp-inbox" ? `data-view="whatsapp"` : action === "import-csv" ? `data-action="import-csv"` : `data-action="${action}"`}>${action === "fingerprint" ? "Simulate scan" : action === "notifications" ? "View message previews" : action === "whatsapp-inbox" ? "Open WhatsApp inbox" : "Import CSV"}</button>` : ""}</article>`).join("")}</div>`;
}

function renderSettings() {
    const gym = state.gym;
    const preferences = gym.preferences || { expiryReminderDays: 7, paymentReminders: true, inactivityReminders: true };
    return `${pageHeading("Settings", "Manage your workspace preferences.")}
        <div class="settings-layout"><div><section class="card settings-section"><h2>Gym profile</h2><form id="settings-form" class="form-grid">
            ${field("Gym name", "name", gym.name, "text", true)}${field("Phone number", "phone", gym.phone, "tel")}
            ${field("Address", "address", gym.address, "text", false, true)}
            <div class="field"><label for="currency">Currency</label><select name="currency" id="currency"><option value="INR" ${gym.currency === "INR" ? "selected" : ""}>INR · Indian Rupee (₹)</option><option value="USD" ${gym.currency === "USD" ? "selected" : ""}>USD · US Dollar ($)</option></select></div>
            <div class="field"><label for="dateFormat">Date format</label><select name="dateFormat" id="dateFormat"><option ${gym.dateFormat === "DD MMM YYYY" ? "selected" : ""}>DD MMM YYYY</option><option ${gym.dateFormat === "DD/MM/YYYY" ? "selected" : ""}>DD/MM/YYYY</option></select></div>
            <div class="field"><label for="setting-language">${t("language")}</label><select id="setting-language" name="language"><option value="en" ${getLanguage() === "en" ? "selected" : ""}>${t("english")}</option><option value="hi" ${getLanguage() === "hi" ? "selected" : ""}>${t("hindi")}</option><option value="mr" ${getLanguage() === "mr" ? "selected" : ""}>${t("marathi")}</option></select></div>
            <div class="field full"><span class="helper-text">Logo placeholder · Upload support can be connected when a backend is added.</span></div>
            <div class="field"><label for="expiryReminderDays">Expiry reminder window (days)</label><input id="expiryReminderDays" name="expiryReminderDays" type="number" min="0" max="90" value="${Number(preferences.expiryReminderDays)}"></div>
            <div class="field full"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="paymentReminders" ${preferences.paymentReminders !== false ? "checked" : ""}> Preview payment-due reminders</label></div>
            <div class="field full"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="inactivityReminders" ${preferences.inactivityReminders !== false ? "checked" : ""}> Preview inactive-member reminders</label></div>
            <div class="field full"><button class="button button-primary" type="submit">Save settings</button></div>
        </form></section>
        <section class="card settings-section"><h2>Membership preferences</h2><p class="helper-text">Membership expiry is evaluated by calendar date. Renewals default to start after the current expiry date when the membership is still valid.</p></section></div>
        ${renderSampleDataCard(gym)}</div>`;
}

// Only demo accounts can load sample data. Anyone who still has sample data in this browser can clear it.
function renderSampleDataCard(gym) {
    if (!gym.isDemo && !state.sampleDataLoaded) return "";
    const load = gym.isDemo ? `<button class="button button-secondary" data-action="load-sample-data">Load sample data</button>` : "";
    return `<aside><section class="card settings-section"><h2>Sample data</h2><p class="helper-text">Load clearly labeled fictional members, payments and attendance into this browser for demonstration only. This data is not uploaded to your gym database.</p>${load}<button class="button button-danger" data-action="reset-demo">Clear local sample data</button></section></aside>`;
}

function field(label, name, value, type = "text", required = false, full = false) {
    return `<div class="field ${full ? "full" : ""}"><label for="setting-${name}">${escapeHTML(label)}</label><input id="setting-${name}" name="${name}" type="${type}" value="${escapeHTML(value || "")}" ${required ? "required" : ""}></div>`;
}
