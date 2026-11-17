import { isVoidedPayment, voidButton, voidNote } from "./paymentVoid.js";
import { renderAccountSettings, renderDeleteGymSettings, renderSupportSettings } from "./account.js";
import { addDays, daysBetween, displayName, escapeHTML, formatDate, formatINR, formatPhone, inactiveDaysFor, indiaISODate, messageName, visitDay } from "../utils.js";
import { state, memberBalance } from "../state.js";
import { emptyRow, emptyState } from "../components/tables.js";
import { PLAN_COLORS, drawChartOrEmpty, hasNonZero, planLegendHtml } from "../components/charts.js";
import { getLanguage, t } from "../i18n.js";
import { welcomePhone } from "../welcomeMessage.js";
import { buildFollowupMessage } from "../followupMessage.js";
import { renderWelcomeTemplateSettings } from "./welcomeUi.js";
import { renderReminderTemplateSettings } from "./expiryReminder.js";
import { renderEnquiryTemplateSettings } from "./enquiryTemplateUi.js";
import { methodLabel, paymentsPage, renderUpiTestQr } from "./upiPayments.js";
import { renderSkeletonList } from "../components/skeleton.js";
import { renderAttendanceSettings } from "./checkinSettingsUi.js";
import { getCurrentMembership } from "./memberMemberships.js";
import { currentMemberCount, currentSummary, monthLabel } from "./summary.js";
import { renderLocalDataSettings } from "./localData.js";
import { renderHoldSettings, renderRenewalSettings } from "./renewalSettingsUi.js";
import { renderSettingsShell } from "./settingsPage.js";

const pageHeading = (title, description, actions = "") =>
    `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;

export function renderOperationsPage(view) {
    // Today, Members, Check-in, Renewals and Plans have their own modules; Visits is part of Check-in.
    const renderers = {
        payments: renderPayments,
        reports: renderReports,
        settings: renderSettings
    };
    return renderers[view]?.() || `<div class="empty-state">This page is not available.</div>`;
}

// Payments recorded in the gym's database, newest first, each with its receipt.
function renderPayments() {
    // Every member's balance, from the database; until it loads, the members in memory.
    const summary = currentSummary().data;
    const pending = summary ? summary.outstanding_total : state.members.reduce((sum, member) => sum + memberBalance(member), 0);
    const actions = `<button class="button button-secondary" data-action="export-payments">↓ Export CSV</button><button class="button button-primary" data-action="record-payment">Record payment</button>`;
    const page = paymentsPage;
    let content;
    if (page.status === "idle" || page.status === "loading") {
        content = `<section class="card skeleton-section">${renderSkeletonList({ count: 4, label: "Loading payments…" })}</section>`;
    } else if (page.status === "error") {
        content = `<div class="empty-state" role="alert"><p>${escapeHTML(page.message)}</p><button class="button button-secondary" data-action="retry-payments">Try again</button></div>`;
    } else {
        content = `<section class="card table-card"><div class="table-wrap"><table class="payments-table"><thead><tr><th>Receipt</th><th>Member</th><th>Date</th><th>Method</th><th>Amount</th><th>UTR</th><th></th></tr></thead><tbody>${page.payments.length
            ? page.payments.map((payment) => `<tr data-payment-row class="${isVoidedPayment(payment) ? "is-voided" : ""}" data-method="${escapeHTML(methodLabel(payment.method))}" data-date="${escapeHTML(payment.paid_on)}"><td data-label="Receipt">${escapeHTML(payment.receipt_number || "—")}</td><td data-label="Member"><span>${escapeHTML(payment.member ? displayName(payment.member.full_name) : "Removed member")}<small class="cell-sub">${escapeHTML(payment.member?.member_code || "")}</small></span></td><td data-label="Date">${formatDate(payment.paid_on)}</td><td data-label="Method">${escapeHTML(methodLabel(payment.method))}</td><td data-label="Amount">${isVoidedPayment(payment) ? `<s class="voided-amount">${formatINR(payment.amount)}</s> <span class="status status-voided">Voided</span>` : formatINR(payment.amount)}${payment.kind === "hold_fee" ? `<small class="cell-sub">Hold fee${payment.refunded_at ? " · refunded" : ""}</small>` : ""}${voidNote(payment)}</td><td data-label="UTR">${escapeHTML(payment.upi_reference || "—")}</td><td data-label="Receipt card"><span class="payment-row-actions"><button class="button button-secondary button-small" data-action="receipt" data-id="${escapeHTML(payment.id)}">Receipt</button>${voidButton(payment, payment.receipt_number)}</span></td></tr>`).join("")
            : emptyRow(7, "No payments yet. They appear here when you renew a member or record one.", `<button class="button button-primary" type="button" data-action="record-payment">Record payment</button>`)}</tbody></table></div></section>`;
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
    return state.members.filter((member) => !["old", "none", "on_hold"].includes(member.memberStatus)).map((member) => {
        const visits = visitsByMember.get(member.id) || [];
        const lastVisit = visits[0];
        const days = inactiveDaysFor(member, lastVisit, today);
        const expiry = memberExpiry(member);
        const expiryDays = expiry ? daysBetween(today, expiry) : null;
        const recentVisits = visits.filter((day) => daysBetween(day, today) <= 14).length;
        const priorVisits = visits.filter((day) => daysBetween(day, today) > 14 && daysBetween(day, today) <= 28).length;
        const reasons = [];
        const since = lastVisit ? "" : " since joining";
        if (days !== null && days >= 30) reasons.push(`No visit${since} in 30+ days`);
        else if (days !== null && days >= 14) reasons.push(`No visit${since} in 14+ days`);
        else if (days !== null && days >= 7) reasons.push(`No visit${since} in 7+ days`);
        if (expiryDays !== null && expiryDays <= 7 && expiryDays >= 0) reasons.push("Membership expiring soon");
        if (expiryDays !== null && expiryDays < 0) reasons.push("Expired without renewal");
        if (priorVisits > 0 && recentVisits < priorVisits) reasons.push("Attendance declining");
        return { member, lastVisit, days, expiryDays, reasons };
    }).filter((row) => row.reasons.length);
}

/**
 * The WhatsApp link for a follow-up: only a member who agreed to messages, with a valid number.
 * Returns { link } or { blocked } (the words to show instead).
 */
export function followupWhatsApp(member, days) {
    if (member.whatsappOptIn !== true) return { blocked: "No WhatsApp consent" };
    const phone = welcomePhone(member.phone);
    if (!phone) return { blocked: "No valid mobile number" };
    const text = buildFollowupMessage({
        language: getLanguage(),
        name: messageName(member.savedName ?? member.name),
        days,
        gymName: state.gym.name,
        gymPhone: state.gym.phone ? formatPhone(state.gym.phone) || state.gym.phone : ""
    });
    return { link: `https://wa.me/91${phone}?text=${encodeURIComponent(text)}` };
}

const FOLLOWUP_STATUSES = ["pending", "contacted", "returned", "renewed", "not interested"];

function followupCard({ member, lastVisit, days, expiryDays, reasons }) {
    const id = escapeHTML(member.id);
    const whatsapp = followupWhatsApp(member, days);
    const action = whatsapp.link
        ? `<a class="button button-secondary button-small" href="${escapeHTML(whatsapp.link)}" target="_blank" rel="noopener noreferrer" data-followup-message="${id}">Send message</a>`
        : `<span class="helper-text reminder-blocked">${escapeHTML(whatsapp.blocked)}</span>`;
    const expiry = memberExpiry(member);
    const facts = [
        lastVisit ? `Last visit ${formatDate(lastVisit)}` : "No visits yet",
        days === null ? "" : `${days} day${days === 1 ? "" : "s"} inactive`,
        expiry ? `${expiryDays !== null && expiryDays < 0 ? "Ended" : "Ends"} ${formatDate(expiry)}` : ""
    ].filter(Boolean).join(" · ");
    const options = FOLLOWUP_STATUSES.map((status) => `<option value="${status}" ${(member.followUpStatus || "pending") === status ? "selected" : ""}>${status[0].toUpperCase() + status.slice(1)}</option>`).join("");
    return `<article class="card followup-card" data-followup-row>
        <div class="followup-member"><button class="text-button member-cell${member.nameMissing ? " name-missing" : ""}" type="button" data-action="${member.nameMissing ? "edit-member" : "profile"}" data-id="${id}"><strong>${escapeHTML(member.name)}</strong></button><small>${escapeHTML(formatPhone(member.phone))}</small></div>
        <div class="followup-detail"><strong>${escapeHTML(reasons.join(" · "))}</strong><small>${escapeHTML(facts)}</small></div>
        <div class="followup-actions">
            <label class="sr-only" for="followup-${id}">Follow-up status for ${escapeHTML(member.name)}</label>
            <select class="field-control followup-select" id="followup-${id}" data-id="${id}">${options}</select>
            ${action}
        </div>
    </article>`;
}

/** The Follow-ups tab of Renewals (the page frame is modules/renewalsPage.js): a card per member. */
export function renderFollowups() {
    const rows = retentionRows();
    const chips = `<div class="summary-row"><span class="summary-chip"><strong>${rows.length}</strong> to follow up</span><span class="summary-chip"><strong>${rows.filter((row) => row.member.followUpStatus === "contacted").length}</strong> contacted</span></div>`;
    const list = rows.length
        ? `<div class="followup-list">${rows.map(followupCard).join("")}</div>`
        : `${emptyState("No one needs a follow-up right now. Members who stop visiting for a while appear here.", `<button class="button button-secondary" type="button" data-view="members">See all members</button>`)}`;
    return `${chips}${list}`;
}

// Totals from the database (every member and payment), check-ins from the last 60 days.
function renderAnalytics() {
    const heading = "";
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
    // One definition everywhere: members with a plan running today (Active or Expiring).
    const active = currentMemberCount(summary);
    const empty = !summary.total_members && !summary.collected_all_time && !state.attendance.length;
    return `${heading}
        ${empty ? `<div class="note-box" role="status" style="margin-bottom:14px">No data yet. Analytics will fill in as you add members, record payments and log check-ins.</div>` : ""}
        <div class="grid kpi-grid">
            ${metric("Active members", active, `Plan running today (Active or Expiring) · ${summary.total_members - active} others`)}
            ${metric("New members", summary.new_members_this_month, "Joined this calendar month")}
            ${metric("Renewed", summary.renewed_last_30_days, `Of ${summary.due_last_30_days} member${summary.due_last_30_days === 1 ? "" : "s"} whose plan ended in the last 30 days, these now have a newer plan`)}
            ${metric("Renewal rate", summary.due_last_30_days ? `${renewalRate}%` : "—", summary.due_last_30_days ? `Renewed ÷ plans ended in the last 30 days = ${summary.renewed_last_30_days} ÷ ${summary.due_last_30_days}` : "No plans ended in the last 30 days")}
            ${metric("Collected this month", formatINR(summary.collected_this_month), "Payments received this calendar month")}
            ${metric("Avg. revenue per member", formatINR(avgRevenue), "All-time collected ÷ all members")}
            ${metric("Outstanding balance", formatINR(summary.outstanding_total), "Billed fees less payments, all members")}
            ${metric("Attendance frequency", `${recentAttendance} visits`, "Recorded during last 30 days")}
        </div>
        <div class="grid content-grid">
            <section class="card"><div class="card-header"><div><h2>Monthly revenue</h2><p>Actual collected payments, by calendar month</p></div></div><div class="chart-area"><canvas id="analytics-revenue" aria-label="Monthly revenue chart"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div></section>
            <section class="card"><div class="card-header"><div><h2>Plan popularity</h2><p>Members with a current plan, by plan</p></div></div><div class="chart-area"><canvas id="plan-chart" aria-label="Membership plan distribution"></canvas><div class="chart-fallback" hidden>Chart library unavailable.</div></div><ul class="chart-legend" id="plan-legend"></ul></section>
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
    const legend = document.querySelector("#plan-legend");
    if (legend) legend.innerHTML = planLegendHtml(plans);
    const charts = [
        drawChartOrEmpty(document.querySelector("#analytics-revenue"), { hasData: hasNonZero(months.map((item) => item.collected)), emptyMessage: "No payments recorded in the last 6 months.", config: {
        type: "line", data: { labels: months.map((item) => monthLabel(item.month)), datasets: [{ data: months.map((item) => item.collected), borderColor: "#4b8b59", backgroundColor: "rgba(110,166,100,.12)", fill: true, tension: .35 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => formatINR(context.raw) } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: "#eef1ed" }, ticks: { callback: (value) => formatINR(value) } } } }
    } }),
        drawChartOrEmpty(document.querySelector("#plan-chart"), { hasData: plans.length > 0, emptyMessage: "No members on a plan yet.", config: {
        type: "doughnut", data: { labels: plans.map((row) => row.plan_name), datasets: [{ data: plans.map((row) => row.members), backgroundColor: PLAN_COLORS, borderWidth: 0 }] },
        options: { maintainAspectRatio: false, cutout: "66%", plugins: { legend: { display: false } } }
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

// Reports: how the gym is doing (the numbers and charts first), then CSV downloads.
function renderReports() {
    return `${pageHeading("Reports", "How your gym is doing, and spreadsheet downloads.", `<button class="button button-secondary" data-action="export-analytics">↓ Export summary</button>`)}
        ${renderAnalytics()}
        <h2 class="section-title" id="downloads">Download a report</h2>
        <section class="card settings-section"><h2>Generate a report</h2><div class="form-grid"><div class="field"><label for="report-type">Report type</label><select id="report-type"><option value="attendance-daily">Daily attendance</option><option value="attendance-monthly">Monthly attendance</option><option value="revenue">Revenue transactions</option><option value="outstanding">Outstanding payments</option><option value="memberships">Memberships</option><option value="renewals">Renewal history</option><option value="inactive">Inactive members</option></select></div><div class="field"><label for="report-date">Date (for daily report)</label><input id="report-date" type="date" value="${indiaISODate()}" max="${indiaISODate()}"></div></div><p class="helper-text" style="margin-top:12px">Reports are made from your gym's database and downloaded to this device. They open in Excel or Google Sheets.</p>
            <p style="margin-top:12px"><button class="button button-secondary" data-action="download-report">↓ Download CSV</button></p></section>
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

// Settings: a list of sections, and the chosen one (modules/settingsPage.js draws the frame).
function renderDetailsSettings() {
    const gym = state.gym;
    const language = getLanguage();
    return `<section class="card settings-section"><h2>Gym details</h2><form id="settings-form" data-section="details" class="form-grid">
        ${field("Gym name", "name", gym.name, "text", true)}${field("Phone number", "phone", gym.phone, "tel")}
        ${field("Address", "address", gym.address, "text", false, true)}
        <div class="field"><label for="setting-language">${t("language")}</label><select id="setting-language" name="language"><option value="en" ${language === "en" ? "selected" : ""}>${t("english")}</option><option value="hi" ${language === "hi" ? "selected" : ""}>${t("hindi")}</option><option value="mr" ${language === "mr" ? "selected" : ""}>${t("marathi")}</option></select><span class="helper-text">For the app's menus and the WhatsApp messages you send.</span></div>
        <div class="field"><label for="dateFormat">Date format</label><select name="dateFormat" id="dateFormat"><option ${gym.dateFormat !== "DD/MM/YYYY" ? "selected" : ""}>DD MMM YYYY</option><option ${gym.dateFormat === "DD/MM/YYYY" ? "selected" : ""}>DD/MM/YYYY</option></select></div>
        <div class="field full"><button class="button button-primary" type="submit">Save gym details</button></div>
    </form></section>`;
}

function renderPaymentSettings() {
    const gym = state.gym;
    return `<section class="card settings-section"><h2>Payments (UPI)</h2><p class="helper-text">Your UPI ID makes the payment QR on the Renew sheet, the check-in poster and receipts.</p><form id="settings-form" data-section="payments" class="form-grid">
        <div class="field"><label for="setting-upiId">UPI ID</label><input id="setting-upiId" name="upiId" type="text" value="${escapeHTML(gym.upiId || "")}" placeholder="powergym@okicici" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="email" maxlength="320" aria-describedby="setting-upiId-help setting-upiId-error"><span class="helper-text" id="setting-upiId-help">Members pay to this ID by scanning the payment QR.</span><span class="helper-text field-error" id="setting-upiId-error" role="alert" hidden></span></div>
        <div class="field"><label for="setting-upiPayeeName">Name shown to payers</label><input id="setting-upiPayeeName" name="upiPayeeName" type="text" value="${escapeHTML(gym.upiPayeeName || "")}" placeholder="${escapeHTML(gym.name || "Gym name")}" maxlength="100"><span class="helper-text">Shown in the member's UPI app. Leave empty to use the gym name.</span></div>
        <div class="field full" id="upi-test-qr" aria-live="polite">${gym.upiId ? renderUpiTestQr(gym.upiId, gym.upiPayeeName) : `<p class="helper-text">Enter your UPI ID to see a ₹1 test QR.</p>`}</div>
        <div class="field full"><button class="button button-primary" type="submit">Save UPI details</button></div>
    </form></section>`;
}

function renderMessageSettings() {
    return `${renderWelcomeTemplateSettings()}${renderReminderTemplateSettings()}${renderEnquiryTemplateSettings()}
        <section class="card settings-section"><h2>Other messages</h2><p class="helper-text">The renewal message to lapsed members, the follow-up check-in, the welcome back message after a plan hold and receipts use built-in wording in English, Hindi and Marathi, chosen by your gym's language (Gym details). They open in WhatsApp with the text filled in, only for members who agreed to messages, and every one is added to the member's WhatsApp history.</p></section>`;
}

const SETTINGS_SECTION_RENDERERS = {
    details: renderDetailsSettings,
    payments: renderPaymentSettings,
    attendance: () => renderAttendanceSettings(),
    renewals: () => renderRenewalSettings(),
    holds: () => renderHoldSettings(),
    messages: renderMessageSettings,
    account: () => `${renderLocalDataSettings()}${renderAccountSettings()}${renderDeleteGymSettings()}`,
    help: () => renderSupportSettings()
};

function renderSettings() {
    return `${pageHeading("Settings", "Your gym's details and preferences, saved for every device.")}${renderSettingsShell((id) => SETTINGS_SECTION_RENDERERS[id]())}`;
}

function field(label, name, value, type = "text", required = false, full = false) {
    return `<div class="field ${full ? "full" : ""}"><label for="setting-${name}">${escapeHTML(label)}</label><input id="setting-${name}" name="${name}" type="${type}" value="${escapeHTML(value || "")}" ${required ? "required" : ""}></div>`;
}
