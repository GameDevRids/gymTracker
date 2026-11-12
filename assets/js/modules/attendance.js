/* global jsQR, BarcodeDetector */
// Check-ins stored in the database. The gym uses one method (Settings > Attendance):
// - member QR card: staff scan the member's QR with the camera on the Check-in screen;
// - entrance poster: members scan a poster with their own phone; staff approve new phones here.
// Both have "Can't scan? Check in manually". Also: the Visits page, a member's visits and linked
// phones, the member card with its QR, and the one-time import of browser-only check-ins.
import { state, getMember, memberFromApiRow, legacyAttendance, clearLegacyAttendance } from "../state.js";
import { apiClient } from "../api/apiClient.js";
import { openModal, closeModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { addDays, escapeHTML, formatDate, formatINR } from "../utils.js";
import { firstName, indiaDate, parseCheckinQr } from "../checkin.js";
import { createWelcomeCard } from "./welcome.js";
import { shareImageFile } from "./cardCanvas.js";
import { checkinMethod, checkinSettings, usesMemberQr, usesPoster } from "./checkinMethod.js";
import { paymentLink, qrSvg } from "./upiPayments.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEED_DAYS = 60;
const RESULT_MS = 3000;
const ACTION_RESULT_MS = 10000;
const SAME_CODE_MS = 5000;
const DESK_POLL_MS = 10000;
const APPROVALS_POLL_MS = 30000;
const STATUS_PILLS = {
    active: ["Active", "active"],
    grace: ["Grace", "expiring"],
    upcoming: ["Starts later", "upcoming"],
    expired: ["Expired", "expired"],
    none: ["No plan", "unassigned"]
};
const METHOD_LABELS = { member_qr: "QR card", qr: "QR card", entrance_poster: "Poster", manual: "Manual" };

function statusPill(status) {
    const [label, tone] = STATUS_PILLS[status] || [status || "Unknown", "inactive"];
    return `<span class="status status-${tone}">${escapeHTML(label)}</span>`;
}

function methodLabel(method) {
    return METHOD_LABELS[method] || "Manual";
}

function timeText(value) {
    return value ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "";
}

function dateTimeText(value) {
    return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "";
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ---------- The last 60 days, from the database (kept in memory, never in browser storage) ----------

export const attendanceFeed = { status: "idle", message: "" };

function feedRecord(row, member = row.member) {
    return {
        id: row.id,
        memberId: row.member_id,
        memberName: member?.full_name || "",
        memberCode: member?.member_code || "",
        checkedInAt: row.checked_in_at,
        checkInDate: row.check_in_date,
        checkedOutAt: "",
        source: row.method,
        status: row.membership_status_at_check_in
    };
}

export async function loadAttendanceFeed(onChange = () => {}) {
    if (state.sampleDataLoaded) return;
    attendanceFeed.status = "loading";
    try {
        const today = indiaDate();
        const response = await apiClient.get("/api/attendance", { params: { from: addDays(today, -(FEED_DAYS - 1)), to: today } });
        if (state.sampleDataLoaded) return;
        state.attendance = (Array.isArray(response?.data) ? response.data : []).map((row) => feedRecord(row));
        attendanceFeed.status = "ready";
    } catch (error) {
        attendanceFeed.status = "error";
        attendanceFeed.message = error.message || "Visits could not be loaded.";
    }
    onChange();
}

/** Replaces today's part of the feed (the front desk refreshes it while open). */
async function refreshToday() {
    const today = indiaDate();
    const response = await apiClient.get("/api/attendance", { params: { date: today } });
    const rows = (Array.isArray(response?.data) ? response.data : []).map((row) => feedRecord(row));
    const before = state.attendance.filter((record) => record.checkInDate === today).map((record) => record.id).join();
    state.attendance = [...rows, ...state.attendance.filter((record) => record.checkInDate !== today)];
    if (attendanceFeed.status !== "ready") attendanceFeed.status = "ready";
    return before !== rows.map((record) => record.id).join();
}

function addToFeed(result) {
    if (state.sampleDataLoaded || !result?.attendance) return;
    const record = feedRecord(result.attendance, result.member);
    state.attendance = [record, ...state.attendance.filter((item) => item.id !== record.id)];
    const history = memberAttendance[record.memberId];
    if (history?.status === "ready" && !history.rows.some((row) => row.id === record.id)) history.rows.unshift(result.attendance);
}

// ---------- Visits page ----------

let selectedDay = "";
const dayCache = { date: "", status: "idle", rows: [], message: "" };

function rowsForDay(day) {
    if (day >= addDays(indiaDate(), -(FEED_DAYS - 1))) return { status: attendanceFeed.status, rows: state.attendance.filter((record) => record.checkInDate === day) };
    return dayCache.date === day ? dayCache : { status: "idle", rows: [] };
}

export async function selectVisitsDay(day, onChange) {
    selectedDay = day;
    if (day >= addDays(indiaDate(), -(FEED_DAYS - 1))) return onChange();
    Object.assign(dayCache, { date: day, status: "loading", rows: [] });
    onChange();
    try {
        const response = await apiClient.get("/api/attendance", { params: { date: day } });
        Object.assign(dayCache, { status: "ready", rows: (response?.data || []).map((row) => feedRecord(row)) });
    } catch (error) {
        Object.assign(dayCache, { status: "error", message: error.message || "Visits could not be loaded." });
    }
    onChange();
}

export function renderVisitsPage() {
    const today = indiaDate();
    const day = selectedDay || today;
    const records = state.attendance;
    const weekStart = addDays(today, -6);
    const todayCount = records.filter((record) => record.checkInDate === today).length;
    const weekCount = records.filter((record) => record.checkInDate >= weekStart).length;
    const monthVisitors = new Set(records.filter((record) => record.checkInDate?.slice(0, 7) === today.slice(0, 7)).map((record) => record.memberId)).size;
    const pending = legacyAttendance().length;
    const view = rowsForDay(day);
    let table;
    if (view.status === "loading" || view.status === "idle") table = `<div class="empty-state" role="status">Loading visits…</div>`;
    else if (view.status === "error") table = `<div class="empty-state" role="alert"><p>${escapeHTML(view.message || attendanceFeed.message)}</p><button class="button button-secondary" data-action="retry-visits">Try again</button></div>`;
    else if (!view.rows.length) table = `<div class="empty-state">${day === today ? "No check-ins yet today." : `No check-ins on ${escapeHTML(formatDate(day))}.`}</div>`;
    else {
        table = `<div class="table-wrap"><table class="visits-table"><thead><tr><th>Time</th><th>Member</th><th>Method</th><th>Membership</th></tr></thead><tbody>${view.rows.map((record) => {
            const name = record.memberName || getMember(record.memberId)?.name || "Removed member";
            return `<tr data-attendance-row><td data-label="Time">${escapeHTML(timeText(record.checkedInAt))}</td><td data-label="Member"><button class="text-button" data-action="profile" data-id="${escapeHTML(record.memberId)}">${escapeHTML(name)}</button><small class="cell-sub">${escapeHTML(record.memberCode)}</small></td><td data-label="Method">${escapeHTML(methodLabel(record.source))}</td><td data-label="Membership">${statusPill(record.status)}</td></tr>`;
        }).join("")}</tbody></table></div>`;
    }
    const policy = checkinSettings.data?.expired_checkin_policy === "block"
        ? "Expired members are not checked in (Settings › Attendance)."
        : "Expired memberships are still recorded and flagged.";
    return `<div class="page-heading"><div><h1>Visits</h1><p>Check-ins at the entrance, stored for your gym.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="checkin-by-name">Check in manually</button><button class="button button-primary" data-view="scan">Check-in screen</button></div></div>
        ${pending ? `<div class="note-box import-note" role="status"><span><strong>${plural(pending, "check-in")}</strong> saved only in this browser by an older version.</span><button class="button button-secondary button-small" data-action="import-browser-checkins">Import check-ins saved in this browser</button></div>` : ""}
        <div class="summary-row"><span class="summary-chip"><strong>${todayCount}</strong> today</span><span class="summary-chip"><strong>${weekCount}</strong> this week</span><span class="summary-chip"><strong>${monthVisitors}</strong> unique visitors this month</span></div>
        <div class="toolbar"><label class="sr-only" for="visits-date">Day</label><input class="field-control" id="visits-date" type="date" value="${escapeHTML(day)}" max="${escapeHTML(today)}"><input class="search-field" id="attendance-search" type="search" placeholder="Search member…" aria-label="Search visits"></div>
        <section class="card table-card">${table}</section>
        <p class="helper-text" style="margin-top:11px">One check-in per member per day (India time). ${escapeHTML(policy)}</p>`;
}

// ---------- A member's visits and linked phones (profile) ----------

export const memberAttendance = {};

export async function loadMemberAttendance(memberId, onChange = () => {}) {
    if (!UUID.test(memberId)) return;
    memberAttendance[memberId] = { status: "loading", rows: memberAttendance[memberId]?.rows || [] };
    onChange();
    try {
        const response = await apiClient.get(`/api/members/${memberId}/attendance`);
        memberAttendance[memberId] = { status: "ready", rows: Array.isArray(response?.data) ? response.data : [] };
    } catch (error) {
        memberAttendance[memberId] = { status: "error", rows: [], message: error.message || "Visits could not be loaded." };
    }
    onChange();
}

export function renderMemberVisits(member) {
    const history = memberAttendance[member.id];
    let body;
    let last = "";
    if (!history || history.status === "loading") body = `<div class="empty-state" role="status">Loading visits…</div>`;
    else if (history.status === "error") body = `<div class="empty-state" role="alert"><p>${escapeHTML(history.message)}</p></div>`;
    else if (!history.rows.length) body = `<div class="empty-state">No check-ins recorded for this member yet.</div>`;
    else {
        const latest = history.rows[0];
        const ago = Math.round((Date.parse(`${indiaDate()}T00:00:00Z`) - Date.parse(`${latest.check_in_date}T00:00:00Z`)) / 86400000);
        last = `<p class="last-visit">Last visit: <strong>${escapeHTML(dateTimeText(latest.checked_in_at))}</strong>${ago === 0 ? " (today)" : ago === 1 ? " (yesterday)" : ` (${ago} days ago)`}</p>`;
        body = `<div class="table-wrap"><table><thead><tr><th>Check-in</th><th>Method</th><th>Membership</th></tr></thead><tbody>${history.rows.slice(0, 10).map((row) => `<tr><td>${escapeHTML(dateTimeText(row.checked_in_at))}</td><td>${escapeHTML(methodLabel(row.method))}</td><td>${statusPill(row.membership_status_at_check_in)}</td></tr>`).join("")}</tbody></table></div>`;
    }
    return `<section class="card profile-section" id="member-visits"><div class="card-header"><div><h2>Visits</h2>${last || "<p>Check-ins at the entrance</p>"}</div><button class="text-button" data-view="attendance">All visits</button></div>${body}</section>`;
}

export const memberDevices = {};

export async function loadMemberDevices(memberId, onChange = () => {}) {
    if (!UUID.test(memberId) || !usesPoster()) return;
    memberDevices[memberId] = { status: "loading", rows: memberDevices[memberId]?.rows || [] };
    try {
        const response = await apiClient.get(`/api/members/${memberId}/devices`);
        memberDevices[memberId] = { status: "ready", rows: Array.isArray(response?.data) ? response.data : [] };
    } catch (error) {
        memberDevices[memberId] = { status: "error", rows: [], message: error.message || "Linked phones could not be loaded." };
    }
    onChange();
}

/** The profile's "Linked phones" (entrance poster gyms only). */
export function renderLinkedPhones(member) {
    if (!usesPoster() || !member.memberCode) return "";
    const devices = memberDevices[member.id];
    let body;
    if (!devices || devices.status === "loading") body = `<div class="empty-state" role="status">Loading linked phones…</div>`;
    else if (devices.status === "error") body = `<div class="empty-state" role="alert"><p>${escapeHTML(devices.message)}</p></div>`;
    else if (!devices.rows.length) body = `<div class="empty-state">No phone linked yet. The member scans the entrance poster and enters their mobile number; you approve it on the Check-in screen.</div>`;
    else {
        body = `<ul class="device-list">${devices.rows.map((device) => `<li class="device-row"><div><strong>${escapeHTML(device.device_label || "Phone")}</strong><small>${device.status === "approved"
            ? `Linked ${escapeHTML(formatDate(device.approved_at?.slice(0, 10)))}${device.last_used_at ? ` · last check-in ${escapeHTML(dateTimeText(device.last_used_at))}` : ""}`
            : `Waiting for approval · code ${escapeHTML(device.code)}`}</small></div>
            ${device.status === "approved"
                ? `<button class="button button-secondary button-small" type="button" data-action="device-revoke" data-id="${escapeHTML(device.id)}" data-member="${escapeHTML(member.id)}">Revoke</button>`
                : `<span class="button-row"><button class="button button-primary button-small" type="button" data-action="device-approve" data-id="${escapeHTML(device.id)}" data-member="${escapeHTML(member.id)}">Approve</button><button class="button button-secondary button-small" type="button" data-action="device-reject" data-id="${escapeHTML(device.id)}" data-member="${escapeHTML(member.id)}">Reject</button></span>`}</li>`).join("")}</ul>`;
    }
    return `<section class="card profile-section" id="linked-phones"><div class="card-header"><div><h2>Linked phones</h2><p>Phones that check this member in at the entrance poster</p></div></div>${body}</section>`;
}

// ---------- Phones waiting for approval (entrance poster) ----------

export const pendingDevices = { status: "idle", rows: [], message: "" };
const approvalListeners = new Set();

function updateApprovalBadges() {
    const count = usesPoster() ? pendingDevices.rows.length : 0;
    document.querySelectorAll("[data-pending-phones]").forEach((badge) => {
        badge.textContent = count ? String(count) : "";
        badge.hidden = !count;
    });
}

export async function loadPendingDevices() {
    if (!usesPoster() || state.sampleDataLoaded) {
        pendingDevices.rows = [];
        updateApprovalBadges();
        return false;
    }
    const before = pendingDevices.rows.map((row) => row.id).join();
    try {
        const response = await apiClient.get("/api/member-devices", { params: { status: "pending" } });
        pendingDevices.rows = Array.isArray(response?.data) ? response.data : [];
        pendingDevices.status = "ready";
    } catch (error) {
        pendingDevices.status = "error";
        pendingDevices.message = error.message || "Phones waiting for approval could not be loaded.";
    }
    updateApprovalBadges();
    return before !== pendingDevices.rows.map((row) => row.id).join();
}

let approvalsTimer = 0;
/** Keeps the "phones waiting" badge current while the app is open (poster gyms only). */
export function watchApprovals(onChange) {
    approvalListeners.add(onChange);
    clearInterval(approvalsTimer);
    const tick = () => {
        if (document.hidden) return;
        loadPendingDevices().then((changed) => { if (changed) approvalListeners.forEach((listener) => listener()); });
    };
    tick();
    approvalsTimer = setInterval(tick, APPROVALS_POLL_MS);
}

function renderApprovals() {
    let body;
    if (pendingDevices.status === "error") body = `<div class="empty-state" role="alert"><p>${escapeHTML(pendingDevices.message)}</p></div>`;
    else if (pendingDevices.status !== "ready") body = `<div class="empty-state" role="status">Loading…</div>`;
    else if (!pendingDevices.rows.length) body = `<p class="helper-text">No phones waiting. A member who scans the poster for the first time enters their mobile number and appears here.</p>`;
    else {
        body = `<ul class="device-list">${pendingDevices.rows.map((device) => `<li class="device-row approval-row"><div><strong>${escapeHTML(device.member?.full_name || "Member")}</strong><small>${escapeHTML(device.member?.member_code || "")}${device.member?.phone_last4 ? ` · ••••${escapeHTML(device.member.phone_last4)}` : ""} · ${escapeHTML(device.device_label || "Phone")} · ${escapeHTML(timeText(device.created_at))}</small></div>
            <div class="approval-code" aria-label="Code on the phone: ${escapeHTML(device.code.split("").join(" "))}"><small>Code on phone</small><strong>${escapeHTML(device.code)}</strong></div>
            <span class="button-row"><button class="button button-primary button-small" type="button" data-action="device-approve" data-id="${escapeHTML(device.id)}">Approve</button><button class="button button-secondary button-small" type="button" data-action="device-reject" data-id="${escapeHTML(device.id)}">Reject</button></span></li>`).join("")}</ul>`;
    }
    return `<section class="card checkin-card" id="device-approvals"><div class="card-header"><div><h2>Phones waiting for approval${pendingDevices.rows.length ? ` <span class="count-pill">${pendingDevices.rows.length}</span>` : ""}</h2><p>Approve only when the code matches the one on the member's phone in front of you.</p></div></div>${body}</section>`;
}

async function changeDevice(action, element, onChange) {
    const id = element.dataset.id;
    element.disabled = true;
    try {
        await apiClient.post(`/api/member-devices/${id}/${action}`, {});
        toast(action === "approve" ? "Phone approved. The member can check in now." : action === "reject" ? "Request rejected." : "Phone unlinked. It can no longer check in.");
        closeModal();
        await loadPendingDevices();
        if (element.dataset.member) await loadMemberDevices(element.dataset.member, () => {});
        onChange();
    } catch (error) {
        toast(error.message || "The phone could not be updated.", "error");
        await loadPendingDevices();
        onChange();
    }
}

function confirmRevoke(element) {
    openModal({
        title: "Revoke this phone?",
        body: `<p class="confirm-copy">The phone can no longer check this member in. To use it again, the member enters their number on the poster page and you approve it.</p>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-danger" type="button" data-action="device-revoke-confirm" data-id="${escapeHTML(element.dataset.id)}" data-member="${escapeHTML(element.dataset.member || "")}">Revoke</button>`
    });
}

// ---------- Recording a check-in ----------

async function ensureMemberLoaded(apiMember) {
    if (!apiMember?.id || getMember(apiMember.id)) return getMember(apiMember?.id);
    try {
        const response = await apiClient.get(`/api/members/${apiMember.id}`);
        const mapped = memberFromApiRow(response?.data);
        if (mapped && !getMember(mapped.id)) state.members.push(mapped);
        return mapped;
    } catch {
        return null;
    }
}

/** A one-line summary of a check-in result, for toasts outside the Check-in screen. */
function resultSentence(data) {
    const name = data.member?.full_name || "Member";
    const time = timeText(data.attendance?.checked_in_at);
    if (data.result === "checked_in") return [`${name} checked in at ${time}.`, "success"];
    if (data.result === "already_checked_in") return [`${name} already checked in today at ${time}.`, "success"];
    if (data.blocked) return [`${name} was not checked in: ${data.result === "upcoming" ? "the plan has not started yet" : data.result === "expired" ? "the membership has expired" : "no active membership"}. Please renew at the desk.`, "error"];
    if (data.result === "grace") return [`${name} checked in. The plan has expired; ${plural(data.grace_days_left, "grace day")} left.`, "success"];
    if (data.result === "upcoming") return [`${name} checked in, but the plan starts on ${formatDate(data.membership?.start_date)}.`, "error"];
    if (data.result === "expired") return [`${name} checked in, but the membership has expired.`, "error"];
    if (data.result === "no_membership") return [`${name} checked in, but has no active membership.`, "error"];
    return ["Member not found.", "error"];
}

function onCheckInScreen() {
    return Boolean(document.querySelector("#checkin-root"));
}

export async function manualCheckIn(memberId, onChange = () => {}) {
    try {
        const response = await apiClient.post("/api/attendance/manual", { member_id: memberId });
        addToFeed(response.data);
        if (onCheckInScreen()) showResult(response.data);
        else toast(...resultSentence(response.data));
        onChange();
        return response.data;
    } catch (error) {
        toast(error.message || "The check-in could not be recorded.", "error");
        return null;
    }
}

// ---------- "Can't scan? Check in manually" ----------

let searchTimer;
let searchRequest = 0;

function renderSearchResults(members, { empty = "No members match." } = {}) {
    const list = document.querySelector("#checkin-results");
    if (!list) return;
    list.innerHTML = members.length
        ? members.map((member) => `<button class="checkin-result" type="button" role="listitem" data-action="checkin-member" data-id="${escapeHTML(member.id)}"><strong>${escapeHTML(member.full_name)}</strong><small>${escapeHTML(member.member_code || "")}${member.phone_last4 ? ` · ••••${escapeHTML(member.phone_last4)}` : ""}${member.usually_now ? ` · <span class="tag tag-usual">Usually here now</span>` : ""}${member.checked_in_today ? ` · <span class="tag">Checked in today</span>` : ""}</small></button>`).join("")
        : `<p class="helper-text">${escapeHTML(empty)}</p>`;
}

export function openCheckInByName() {
    openModal({
        title: "Check in manually",
        subtitle: "Type the last 4 digits of the member's phone, or part of their name.",
        body: `<div class="field"><label for="checkin-search">Last 4 digits or name</label><input id="checkin-search" type="search" autocomplete="off" autocapitalize="words" spellcheck="false" placeholder="e.g. 3210 or Riya" enterkeyhint="search"></div><div id="checkin-results" class="checkin-results" role="list" aria-live="polite"><p class="helper-text">Loading…</p></div>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Close</button>`
    });
    searchCheckInMembers("", { immediate: true });
    document.querySelector("#checkin-search")?.focus();
}

export function searchCheckInMembers(text, { immediate = false } = {}) {
    clearTimeout(searchTimer);
    const request = ++searchRequest;
    const query = String(text || "").trim();
    searchTimer = setTimeout(async () => {
        try {
            const response = await apiClient.get("/api/attendance/search", { params: query ? { q: query } : {} });
            if (request !== searchRequest) return;
            renderSearchResults(Array.isArray(response?.data) ? response.data : [], { empty: query ? "No members match." : "Start typing. Members who usually come at this time are listed here." });
        } catch (error) {
            if (request === searchRequest) renderSearchResults([], { empty: error.message || "Members could not be searched." });
        }
    }, immediate ? 0 : 120);
}

// ---------- The Check-in screen ----------

let scanner = null;
let desk = null;
let lastResult = null;

function scannerElement(selector) {
    return document.querySelector(`#scanner-root ${selector}`);
}

function resultBox() {
    return document.querySelector("#checkin-root #scan-result");
}

const manualButton = `<button class="button button-secondary manual-checkin-button" type="button" data-action="checkin-by-name">Can't scan? Check in manually</button>`;

function renderTodayList() {
    const today = indiaDate();
    const rows = state.attendance.filter((record) => record.checkInDate === today).slice(0, 12);
    const body = rows.length
        ? `<ul class="today-list">${rows.map((record) => `<li class="${record.status === "active" ? "" : "today-flagged"}"><span class="today-time">${escapeHTML(timeText(record.checkedInAt))}</span><button class="text-button" data-action="profile" data-id="${escapeHTML(record.memberId)}">${escapeHTML(record.memberName || "Member")}</button><span class="today-meta">${escapeHTML(methodLabel(record.source))} ${record.status === "active" ? "" : statusPill(record.status)}</span></li>`).join("")}</ul>`
        : `<p class="helper-text">No check-ins yet today.</p>`;
    return `<section class="card checkin-card" id="today-checkins"><div class="card-header"><div><h2>Today</h2><p>${plural(state.attendance.filter((record) => record.checkInDate === today).length, "check-in")} · updates every few seconds</p></div><button class="text-button" data-view="attendance">All visits</button></div>${body}</section>`;
}

function deskResultHtml() {
    if (!lastResult || lastResult.until < Date.now()) return `<div class="scan-result desk-result" id="scan-result" hidden aria-live="assertive"></div>`;
    // Redrawn by the desk refresh: the member is loaded by now, so Renew and Record payment work.
    const html = getMember(lastResult.data.member?.id) ? lastResult.html.replaceAll(" disabled>", ">") : lastResult.html;
    return `<div class="scan-result desk-result scan-${lastResult.tone}" id="scan-result" aria-live="assertive">${html}</div>`;
}

export function renderCheckInPage() {
    const heading = (text, actions = "") => `<div class="page-heading"><div><h1>Check-in</h1><p>${text}</p></div><div class="heading-actions">${actions}</div></div>`;
    if (state.sampleDataLoaded) {
        return `${heading("Sample data is loaded in this browser.")}<section class="card"><div class="empty-state"><p>Check-ins for sample members stay in this browser.</p><button class="button button-primary" data-action="check-in">Record a check-in</button></div></section>`;
    }
    const method = checkinMethod();
    if (!method) {
        const body = checkinSettings.status === "error"
            ? `<div class="empty-state" role="alert"><p>${escapeHTML(checkinSettings.message)}</p><button class="button button-secondary" type="button" data-action="retry-checkin-settings">Try again</button></div>`
            : `<div class="empty-state" role="status">Loading…</div>`;
        return `<div id="checkin-root">${heading("")}<section class="card">${body}</section></div>`;
    }
    if (method === "member_qr") {
        return `<div id="checkin-root" data-method="member_qr">${heading("Hold the member's QR card in front of the camera. Each result shows for a few seconds, then scanning continues.", `<button class="button button-secondary" data-view="attendance">Today's visits</button>`)}
            <section class="card scanner" id="scanner-root">
                <div class="scanner-stage">
                    <video id="scanner-video" playsinline muted autoplay aria-label="Camera view"></video>
                    <div class="scanner-frame" aria-hidden="true"></div>
                    <p class="scanner-status" id="scanner-status" role="status">Starting camera…</p>
                    <div class="scan-result" id="scan-result" hidden aria-live="assertive"></div>
                </div>
            </section>
            <div class="manual-row">${manualButton}</div></div>`;
    }
    return `<div id="checkin-root" data-method="entrance_poster">${heading("Members scan the poster at the entrance with their own phone. Approve new phones here.", `<button class="button button-secondary" data-view="settings">Poster</button>`)}
        ${deskResultHtml()}
        <div class="manual-row">${manualButton}</div>
        ${renderApprovals()}
        ${renderTodayList()}</div>`;
}

/** Starts what the Check-in screen needs: the camera (member QR) or the front-desk refresh (poster). */
export function startCheckInScreen(onChange = () => {}) {
    if (state.sampleDataLoaded) return;
    if (usesMemberQr()) {
        stopDesk();
        startScanner();
    } else if (usesPoster()) {
        stopScanner();
        startDesk(onChange);
    }
}

export function stopCheckInScreen() {
    stopScanner();
    stopDesk();
}

function startDesk(onChange) {
    if (desk) return;
    const session = { timer: 0, stopped: false };
    desk = session;
    const tick = async () => {
        if (session.stopped) return;
        if (!document.hidden) {
            try {
                const [feedChanged, phonesChanged] = await Promise.all([refreshToday(), loadPendingDevices()]);
                if (!session.stopped && (feedChanged || phonesChanged || pendingDevices.status !== "ready")) onChange();
            } catch {
                // The next refresh tries again.
            }
        }
        if (!session.stopped) session.timer = setTimeout(tick, DESK_POLL_MS);
    };
    tick().then(() => onChange());
}

function stopDesk() {
    if (!desk) return;
    desk.stopped = true;
    clearTimeout(desk.timer);
    desk = null;
}

// ---------- The camera (member QR method) ----------

function setStatus(text) {
    const status = scannerElement("#scanner-status");
    if (status) {
        status.textContent = text;
        status.hidden = !text;
    }
}

function cameraProblem(error) {
    const name = error?.name || "";
    if (!window.isSecureContext) return "The camera needs a secure (https) connection.";
    if (name === "NotAllowedError" || name === "SecurityError") return "Camera access is blocked. Allow the camera for this site in your browser settings, then tap Try again.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device.";
    if (name === "NotReadableError") return "The camera is being used by another app. Close it and tap Try again.";
    return error?.message || "The camera could not start.";
}

function showCameraProblem(message) {
    const stage = scannerElement(".scanner-stage");
    if (!stage) return;
    stage.classList.add("scanner-blocked");
    setStatus("");
    const result = scannerElement("#scan-result");
    result.hidden = false;
    result.className = "scan-result scan-grey";
    result.innerHTML = `<p class="scan-title">Camera unavailable</p><p class="scan-line">${escapeHTML(message)}</p><div class="scan-actions"><button class="button button-primary" type="button" data-action="checkin-by-name">Check in manually</button><button class="button button-secondary" type="button" data-action="scanner-retry">Try again</button></div>`;
}

function loadScript(src) {
    if (typeof window.jsQR === "function") return Promise.resolve();
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("The QR reader could not load."));
        document.head.append(script);
    });
}

// BarcodeDetector where the browser has it (Android Chrome); otherwise jsQR from assets/vendor.
async function createDetector() {
    if ("BarcodeDetector" in window) {
        try {
            const formats = await BarcodeDetector.getSupportedFormats();
            if (formats.includes("qr_code")) {
                const detector = new BarcodeDetector({ formats: ["qr_code"] });
                return { kind: "BarcodeDetector", detect: async (video) => (await detector.detect(video))[0]?.rawValue || "" };
            }
        } catch {
            // Fall through to jsQR.
        }
    }
    await loadScript("/assets/vendor/jsQR-1.4.0.js");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    return {
        kind: "jsQR",
        detect: async (video) => {
            const width = video.videoWidth;
            const height = video.videoHeight;
            if (!width || !height) return "";
            const scale = Math.min(1, 720 / Math.max(width, height));
            canvas.width = Math.round(width * scale);
            canvas.height = Math.round(height * scale);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            return jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data || "";
        }
    };
}

export async function startScanner() {
    if (scanner || !document.querySelector("#scanner-root")) return;
    const session = { stream: null, detect: null, timer: 0, hideTimer: 0, busy: false, showing: false, lastText: "", lastAt: 0, stopped: false };
    scanner = session;
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
        showCameraProblem(cameraProblem(new Error("This browser cannot use the camera here.")));
        return;
    }
    try {
        session.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (session.stopped) return stopTracks(session);
        const video = scannerElement("#scanner-video");
        video.srcObject = session.stream;
        await video.play().catch(() => {});
        const detector = await createDetector();
        if (session.stopped) return stopTracks(session);
        session.detect = detector.detect;
        session.kind = detector.kind;
        document.querySelector("#scanner-root").dataset.reader = detector.kind;
        setStatus("Scanning…");
        tick(session);
    } catch (error) {
        if (!session.stopped) showCameraProblem(cameraProblem(error));
    }
}

function stopTracks(session) {
    session.stream?.getTracks().forEach((track) => track.stop());
    session.stream = null;
}

export function stopScanner() {
    if (!scanner) return;
    scanner.stopped = true;
    clearTimeout(scanner.timer);
    clearTimeout(scanner.hideTimer);
    stopTracks(scanner);
    const video = document.querySelector("#scanner-video");
    if (video) video.srcObject = null;
    scanner = null;
}

export function restartScanner() {
    stopScanner();
    const stage = scannerElement(".scanner-stage");
    stage?.classList.remove("scanner-blocked");
    const result = scannerElement("#scan-result");
    if (result) result.hidden = true;
    setStatus("Starting camera…");
    startScanner();
}

function modalOpen() {
    return Boolean(document.querySelector("#modal-root")?.childElementCount);
}

async function tick(session) {
    if (session.stopped) return;
    const video = scannerElement("#scanner-video");
    if (!session.showing && !session.busy && !modalOpen() && video?.readyState >= 2 && !document.hidden) {
        session.busy = true;
        try {
            const text = await session.detect(video);
            if (text && !session.stopped) await handleCode(session, text);
        } catch {
            // A frame that cannot be read is skipped.
        } finally {
            session.busy = false;
        }
    }
    if (!session.stopped) session.timer = setTimeout(() => tick(session), 150);
}

async function handleCode(session, text) {
    const now = Date.now();
    // The same QR held in front of the camera is read many times a second: ignore repeats for 5 s.
    if (text === session.lastText && now - session.lastAt < SAME_CODE_MS) return;
    session.lastText = text;
    session.lastAt = now;
    const token = parseCheckinQr(text);
    if (!token) return showResult({ result: "not_recognised" });
    setStatus("Checking…");
    try {
        const response = await apiClient.post("/api/attendance/scan", { token });
        addToFeed(response.data);
        showResult(response.data);
    } catch (error) {
        showResult({ result: "error", message: error.message });
    }
}

function vibrate(pattern) {
    try {
        navigator.vibrate?.(pattern);
    } catch {
        // Vibration is optional.
    }
}

// ---------- Result cards (all methods) ----------

function planLine(membership) {
    if (!membership) return "";
    const left = membership.days_left;
    return `${membership.plan_name}${left > 0 ? ` · ${plural(left, "day")} left` : left === 0 ? " · last day today" : ""}`;
}

function renewalActions(data) {
    const member = data.member;
    const id = escapeHTML(member.id);
    const renew = data.result === "no_membership" && !data.membership ? "Assign plan" : "Renew";
    const amount = data.renewal_price ? `data-amount="${escapeHTML(String(data.renewal_price))}"` : "";
    return `<div class="scan-actions">
        <button class="button button-primary" type="button" data-action="assign-member-plan" data-id="${id}" disabled>${renew}</button>
        ${data.renewal_price ? `<button class="button button-secondary" type="button" data-action="checkin-upi-qr" ${amount}>Show UPI QR</button>` : ""}
        <button class="button button-secondary" type="button" data-action="record-payment" data-id="${id}" ${amount} disabled>Record payment</button>
        ${scanner ? `<button class="button button-secondary" type="button" data-action="scanner-continue">Continue scanning</button>` : `<button class="button button-secondary" type="button" data-action="checkin-result-close">Done</button>`}
    </div>`;
}

/** The big result card: over the camera (member QR), or at the top of the front desk (poster). */
export function showResult(data) {
    const box = resultBox();
    if (!box) return;
    const session = scanner;
    const name = data.member?.full_name || "";
    const first = firstName(name) || "Member";
    const membership = data.membership;
    const plan = planLine(membership);
    const time = timeText(data.attendance?.checked_in_at);
    let tone = "grey";
    let html = "";
    let duration = RESULT_MS;
    if (data.result === "checked_in") {
        tone = "green";
        vibrate(80);
        html = `<p class="scan-title">Welcome, ${escapeHTML(first)} ✓</p><p class="scan-line">Checked in ${escapeHTML(time)}</p>${plan ? `<p class="scan-sub">${escapeHTML(plan)}</p>` : ""}`;
    } else if (data.result === "already_checked_in") {
        tone = "amber";
        vibrate([60, 80, 60]);
        html = `<p class="scan-title">${escapeHTML(name)}</p><p class="scan-line">Already checked in today at ${escapeHTML(time)}</p>${plan ? `<p class="scan-sub">${escapeHTML(plan)}</p>` : ""}`;
    } else if (data.result === "grace") {
        tone = "amber";
        vibrate([60, 80, 60]);
        duration = ACTION_RESULT_MS;
        const ago = Math.max(0, -(membership?.days_left ?? 0));
        html = `<p class="scan-title">Welcome, ${escapeHTML(first)}</p><p class="scan-line">Checked in ${escapeHTML(time)} · plan expired ${ago === 1 ? "yesterday" : `${ago} days ago`}</p><p class="scan-sub">${data.grace_days_left > 0 ? `${plural(data.grace_days_left, "grace day")} left` : "Last grace day today"}. Please renew.</p>${renewalActions(data)}`;
    } else if (data.result === "upcoming") {
        tone = "amber";
        vibrate([60, 80, 60]);
        duration = ACTION_RESULT_MS;
        const starts = formatDate(membership?.start_date);
        html = `<p class="scan-title">${escapeHTML(name)}</p><p class="scan-line">Plan starts on ${escapeHTML(starts)}</p><p class="scan-sub">${data.blocked ? "Not checked in." : "Check-in recorded and flagged."}</p><div class="scan-actions">${scanner ? `<button class="button button-secondary" type="button" data-action="scanner-continue">Continue scanning</button>` : `<button class="button button-secondary" type="button" data-action="checkin-result-close">Done</button>`}</div>`;
    } else if (data.result === "expired" || data.result === "no_membership") {
        tone = "red";
        vibrate([200, 100, 200]);
        duration = ACTION_RESULT_MS;
        const ago = Math.max(0, -(membership?.days_left ?? 0));
        const headline = data.result === "expired" ? `Membership expired ${ago === 1 ? "yesterday" : `${ago} days ago`}` : "No active membership";
        html = `<p class="scan-title">${escapeHTML(name)}</p><p class="scan-line">${escapeHTML(headline)}</p><p class="scan-sub">${data.blocked ? "<strong>Not checked in.</strong> Please renew at the desk." : "Check-in recorded and flagged."}${data.renewal_price ? ` Renewal ${escapeHTML(formatINR(data.renewal_price))}.` : ""}</p>${renewalActions(data)}`;
    } else if (data.result === "error") {
        vibrate(300);
        html = `<p class="scan-title">Couldn't check in</p><p class="scan-line">${escapeHTML(data.message || "Please try again.")}</p>`;
    } else {
        vibrate(300);
        html = `<p class="scan-title">QR not recognised</p><p class="scan-line">This is not a member QR for this gym.</p>`;
    }
    lastResult = { data, tone, html, until: Date.now() + duration };
    box.className = `scan-result scan-${tone}${session ? "" : " desk-result"}`;
    box.innerHTML = html;
    box.hidden = false;
    if (data.member && box.querySelector("[disabled]")) {
        // Renew and Record payment work on a member loaded in this browser.
        ensureMemberLoaded(data.member).then((member) => {
            if (member) box.querySelectorAll("[disabled]").forEach((button) => { button.disabled = false; });
        });
    }
    if (session) {
        setStatus("");
        session.showing = true;
        clearTimeout(session.hideTimer);
        session.hideTimer = setTimeout(() => hideResult(session), duration);
    } else {
        box.scrollIntoView({ block: "nearest" });
        clearTimeout(showResult.timer);
        showResult.timer = setTimeout(() => {
            const current = resultBox();
            if (current && lastResult?.until <= Date.now()) current.hidden = true;
        }, duration + 50);
    }
}

function hideResult(session) {
    if (session !== scanner) return;
    session.showing = false;
    const box = scannerElement("#scan-result");
    if (box) box.hidden = true;
    setStatus("Scanning…");
}

export function continueScanning() {
    lastResult = null;
    if (scanner) {
        clearTimeout(scanner.hideTimer);
        hideResult(scanner);
    } else {
        const box = resultBox();
        if (box) box.hidden = true;
    }
}

/** The gym's UPI QR for the renewal price, shown on the staff screen for the member to scan. */
function showRenewalQr(element) {
    const data = lastResult?.data;
    const amount = Number(element.dataset.amount || data?.renewal_price);
    const payment = paymentLink({ amount, memberCode: data?.member?.member_code || "", planName: data?.membership?.plan_name || "" });
    const body = payment.link
        ? `<div class="upi-qr-view">${qrSvg(payment.link, `UPI QR for ${formatINR(amount)}`)}<p class="upi-amount">${escapeHTML(formatINR(amount))}</p><p class="helper-text">The member scans this with any UPI app. Check the payment arrived, then tap Record payment.</p></div>`
        : `<p class="helper-text">${payment.reason === "no-upi" ? "Set the gym's UPI ID in Settings first." : escapeHTML(payment.message || "Enter an amount to show the QR.")}</p>`;
    openModal({
        title: "Renew with UPI",
        subtitle: data?.member ? `${escapeHTML(data.member.full_name)} · ${escapeHTML(data.membership?.plan_name || "")}` : "",
        body,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Close</button>${data?.member ? `<button class="button button-primary" type="button" data-action="record-payment" data-id="${escapeHTML(data.member.id)}" data-amount="${escapeHTML(String(amount))}">Record payment</button>` : ""}`
    });
}

// ---------- Member card (member QR method) ----------

let openCard = null;

export async function openMemberCard(memberId) {
    openModal({ title: "Member card", body: `<div class="empty-state" role="status">Preparing the card…</div>`, footer: `<button class="button button-secondary" type="button" data-action="close-modal">Close</button>` });
    let member;
    let file;
    try {
        const response = await apiClient.get(`/api/members/${memberId}`);
        member = memberFromApiRow(response?.data);
        if (!member?.qrToken) throw new Error("This member has no check-in QR yet. Run migration 012.");
        const stored = getMember(member.id);
        if (stored) stored.qrToken = member.qrToken;
        file = await createWelcomeCard(member, { membership: member.currentMembership, variant: "member" });
    } catch (error) {
        openModal({ title: "Member card", body: `<div class="empty-state" role="alert"><p>${escapeHTML(error.message || "The member card could not be made.")}</p></div>`, footer: `<button class="button button-secondary" type="button" data-action="close-modal">Close</button>` });
        return;
    }
    if (openCard?.url) URL.revokeObjectURL(openCard.url);
    openCard = { member, file, url: URL.createObjectURL(file) };
    openModal({
        title: "Member card",
        subtitle: `${escapeHTML(member.name)} · ${escapeHTML(member.memberCode || "")}`,
        body: `<div class="member-card-view"><img class="member-card-preview" src="${openCard.url}" alt="Member card for ${escapeHTML(member.name)} with check-in QR"><p class="helper-text">The QR checks this member in at the entrance. If the card is lost or shared, reissue the QR: the old one stops working.</p></div>`,
        footer: `<div class="welcome-footer">
            <button class="button button-secondary" type="button" data-action="member-qr-reissue" data-id="${escapeHTML(member.id)}">Reissue QR</button>
            <button class="button button-secondary" type="button" data-action="member-card-print">Print</button>
            <button class="button button-whatsapp" type="button" data-action="member-card-share">Share member card</button>
        </div>`
    });
}

function shareMemberCard(button) {
    if (!openCard) return;
    button.disabled = true;
    shareImageFile(openCard.file, { text: `${openCard.member.name}'s member card` })
        .then((result) => { if (result === "downloaded") toast("Member card saved."); })
        .catch((error) => toast(error.message || "The member card could not be shared.", "error"))
        .finally(() => { if (button.isConnected) button.disabled = false; });
}

function printMemberCard() {
    if (!openCard) return;
    const popup = window.open("", "_blank");
    if (!popup) return toast("Allow pop-ups to print the member card.", "error");
    popup.opener = null;
    popup.document.write(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Member card · ${escapeHTML(openCard.member.name)}</title><style>@page{margin:12mm}body{margin:0;display:flex;justify-content:center;font:14px Arial,sans-serif}img{width:80mm;height:auto;border-radius:3mm}</style><img src="${openCard.url}" alt="Member card for ${escapeHTML(openCard.member.name)}"></html>`);
    popup.document.close();
    const image = popup.document.querySelector("img");
    const print = () => { popup.focus(); popup.print(); };
    if (image.complete) print();
    else image.addEventListener("load", print, { once: true });
}

export function confirmReissue(memberId) {
    const member = getMember(memberId) || openCard?.member;
    openModal({
        title: "Reissue QR?",
        body: `<p class="confirm-copy">${escapeHTML(member?.name || "This member")} gets a new check-in QR. <strong>The old QR stops working immediately</strong>, including any printed or shared card. Use this when a card is lost or shared.</p>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-danger" type="button" data-action="member-qr-reissue-confirm" data-id="${escapeHTML(memberId)}">Reissue QR</button>`
    });
}

async function reissue(memberId, button) {
    if (button) button.disabled = true;
    try {
        await apiClient.post(`/api/members/${memberId}/qr-token/reissue`, {});
        const stored = getMember(memberId);
        if (stored) delete stored.qrToken;
        toast("New QR issued. The old QR no longer works.");
        await openMemberCard(memberId);
    } catch (error) {
        toast(error.message || "The QR could not be reissued.", "error");
        if (button?.isConnected) button.disabled = false;
    }
}

// ---------- Import from this browser ----------

async function importBrowserCheckIns(button, onChange) {
    const records = legacyAttendance()
        .filter((record) => UUID.test(record.memberId) && !Number.isNaN(Date.parse(record.checkedInAt)))
        .map((record) => ({ member_id: record.memberId, checked_in_at: new Date(record.checkedInAt).toISOString() }));
    const ignored = legacyAttendance().length - records.length;
    if (button) button.disabled = true;
    try {
        const totals = { imported: 0, already_recorded: 0, skipped: ignored };
        for (let index = 0; index < records.length; index += 5000) {
            const response = await apiClient.post("/api/attendance/import", { records: records.slice(index, index + 5000) });
            totals.imported += response.data.imported;
            totals.already_recorded += response.data.already_recorded;
            totals.skipped += response.data.skipped;
        }
        clearLegacyAttendance();
        toast(`Imported ${plural(totals.imported, "check-in")}${totals.already_recorded ? `, ${totals.already_recorded} already recorded` : ""}${totals.skipped ? `, ${totals.skipped} skipped (removed members or repeats)` : ""}.`);
        await loadAttendanceFeed(onChange);
    } catch (error) {
        toast(error.message || "The check-ins could not be imported.", "error");
        if (button?.isConnected) button.disabled = false;
    }
}

// ---------- Actions ----------

/** Handles the check-in screens' buttons. Returns true when the action was handled. */
export function handleAttendanceAction(action, element, onChange) {
    switch (action) {
        case "checkin-by-name": openCheckInByName(); return true;
        case "checkin-member": closeModal(); manualCheckIn(element.dataset.id, onChange); return true;
        case "scanner-continue": continueScanning(); return true;
        case "checkin-result-close": continueScanning(); return true;
        case "scanner-retry": restartScanner(); return true;
        case "checkin-upi-qr": showRenewalQr(element); return true;
        case "member-card": openMemberCard(element.dataset.id); return true;
        case "member-card-share": shareMemberCard(element); return true;
        case "member-card-print": printMemberCard(); return true;
        case "member-qr-reissue": confirmReissue(element.dataset.id); return true;
        case "member-qr-reissue-confirm": reissue(element.dataset.id, element); return true;
        case "device-approve": changeDevice("approve", element, onChange); return true;
        case "device-reject": changeDevice("reject", element, onChange); return true;
        case "device-revoke": confirmRevoke(element); return true;
        case "device-revoke-confirm": changeDevice("revoke", element, onChange); return true;
        case "import-browser-checkins": importBrowserCheckIns(element, onChange); return true;
        case "retry-visits": loadAttendanceFeed(onChange); return true;
        default: return false;
    }
}
