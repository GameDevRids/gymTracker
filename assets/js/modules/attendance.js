/* global jsQR, BarcodeDetector */
// Check-ins stored in the database: the scanner at the entrance, check in by name, the Visits
// page, a member's visit history, the member card with its QR, and the one-time import of
// check-ins an older version saved only in this browser.
import { state, getMember, memberFromApiRow, legacyAttendance, clearLegacyAttendance } from "../state.js";
import { apiClient } from "../api/apiClient.js";
import { openModal, closeModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { addDays, escapeHTML, formatDate, statusPill } from "../utils.js";
import { indiaDate, parseCheckinQr } from "../checkin.js";
import { welcomePhone } from "../welcomeMessage.js";
import { createWelcomeCard } from "./welcome.js";
import { shareImageFile } from "./cardCanvas.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEED_DAYS = 60;
const RESULT_MS = 3000;
const ACTION_RESULT_MS = 10000;
const SAME_CODE_MS = 5000;
const STATUS_LABELS = { active: "Active", expired: "Expired", none: "No plan" };

function timeText(value) {
    return value ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "";
}

function dateTimeText(value) {
    return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "";
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
            return `<tr data-attendance-row><td data-label="Time">${escapeHTML(timeText(record.checkedInAt))}</td><td data-label="Member"><button class="text-button" data-action="profile" data-id="${escapeHTML(record.memberId)}">${escapeHTML(name)}</button><small class="cell-sub">${escapeHTML(record.memberCode)}</small></td><td data-label="Method">${record.source === "qr" ? "QR" : "Manual"}</td><td data-label="Membership">${statusPill(record.status === "none" ? "unassigned" : record.status)}</td></tr>`;
        }).join("")}</tbody></table></div>`;
    }
    return `<div class="page-heading"><div><h1>Visits</h1><p>Check-ins recorded at the entrance, stored for your gym.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="checkin-by-name">Check in by name</button><button class="button button-primary" data-view="scan">Scan check-in</button></div></div>
        ${pending ? `<div class="note-box import-note" role="status"><span><strong>${pending} check-in${pending === 1 ? "" : "s"}</strong> saved only in this browser by an older version.</span><button class="button button-secondary button-small" data-action="import-browser-checkins">Import check-ins saved in this browser</button></div>` : ""}
        <div class="summary-row"><span class="summary-chip"><strong>${todayCount}</strong> today</span><span class="summary-chip"><strong>${weekCount}</strong> this week</span><span class="summary-chip"><strong>${monthVisitors}</strong> unique visitors this month</span></div>
        <div class="toolbar"><label class="sr-only" for="visits-date">Day</label><input class="field-control" id="visits-date" type="date" value="${escapeHTML(day)}" max="${escapeHTML(today)}"><input class="search-field" id="attendance-search" type="search" placeholder="Search member…" aria-label="Search visits"></div>
        <section class="card table-card">${table}</section>
        <p class="helper-text" style="margin-top:11px">One check-in per member per day (India time). Expired memberships are still recorded and flagged.</p>`;
}

// ---------- A member's visits (profile) ----------

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
        body = `<div class="table-wrap"><table><thead><tr><th>Check-in</th><th>Method</th><th>Membership</th></tr></thead><tbody>${history.rows.slice(0, 10).map((row) => `<tr><td>${escapeHTML(dateTimeText(row.checked_in_at))}</td><td>${row.method === "qr" ? "QR" : "Manual"}</td><td>${escapeHTML(STATUS_LABELS[row.membership_status_at_check_in] || row.membership_status_at_check_in)}</td></tr>`).join("")}</tbody></table></div>`;
    }
    return `<section class="card profile-section" id="member-visits"><div class="card-header"><div><h2>Visits</h2>${last || "<p>Check-ins at the entrance</p>"}</div><button class="text-button" data-view="attendance">All visits</button></div>${body}</section>`;
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

/** A one-line summary of a check-in result, for toasts outside the scanner. */
function resultSentence(data) {
    const name = data.member?.full_name || "Member";
    if (data.result === "checked_in") return [`${name} checked in at ${timeText(data.attendance?.checked_in_at)}.`, "success"];
    if (data.result === "already_checked_in") return [`${name} already checked in today at ${timeText(data.attendance?.checked_in_at)}.`, "success"];
    if (data.result === "expired") return [`${name} checked in, but the membership has expired.`, "error"];
    if (data.result === "no_membership") return [`${name} checked in, but has no active membership.`, "error"];
    return ["Member not found.", "error"];
}

export async function manualCheckIn(memberId, onChange = () => {}) {
    try {
        const response = await apiClient.post("/api/attendance/manual", { member_id: memberId });
        addToFeed(response.data);
        if (scanner) showResult(response.data);
        else toast(...resultSentence(response.data));
        onChange();
        return response.data;
    } catch (error) {
        toast(error.message || "The check-in could not be recorded.", "error");
        return null;
    }
}

// ---------- Check in by name ----------

let searchTimer;
let searchRequest = 0;

function renderSearchResults(members) {
    const list = document.querySelector("#checkin-results");
    if (!list) return;
    list.innerHTML = members.length
        ? members.map((member) => `<button class="checkin-result" type="button" role="listitem" data-action="checkin-member" data-id="${escapeHTML(member.id)}"><strong>${escapeHTML(member.name)}</strong><small>${escapeHTML(member.memberCode || "")} · ${escapeHTML(member.phone || "")}</small></button>`).join("")
        : `<p class="helper-text">No members match.</p>`;
}

export function openCheckInByName() {
    openModal({
        title: "Check in by name",
        subtitle: "For members without their QR, or when the camera is unavailable.",
        body: `<div class="field"><label for="checkin-search">Name, phone or member ID</label><input id="checkin-search" type="search" autocomplete="off" placeholder="Start typing…"></div><div id="checkin-results" class="checkin-results" role="list"></div>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Close</button>`
    });
    renderSearchResults(state.members.filter((member) => UUID.test(member.id)).slice(0, 12));
    document.querySelector("#checkin-search")?.focus();
}

export function searchCheckInMembers(text) {
    clearTimeout(searchTimer);
    const request = ++searchRequest;
    searchTimer = setTimeout(async () => {
        try {
            const response = await apiClient.get("/api/members", { params: { search: text.trim(), limit: 20, page: 1 } });
            if (request !== searchRequest) return;
            renderSearchResults((response?.data?.members || []).map((row) => memberFromApiRow(row)));
        } catch (error) {
            if (request === searchRequest) toast(error.message || "Members could not be searched.", "error");
        }
    }, 250);
}

// ---------- The scanner ----------

let scanner = null;

function scannerElement(selector) {
    return document.querySelector(`#scanner-root ${selector}`);
}

export function renderScanPage() {
    return `<div class="page-heading"><div><h1>Scan check-in</h1><p>Hold the member's QR in front of the camera. Each result shows for a few seconds, then scanning continues.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="checkin-by-name">Check in by name</button><button class="button button-secondary" data-view="attendance">Today's visits</button></div></div>
        <section class="card scanner" id="scanner-root">
            <div class="scanner-stage">
                <video id="scanner-video" playsinline muted autoplay aria-label="Camera view"></video>
                <div class="scanner-frame" aria-hidden="true"></div>
                <p class="scanner-status" id="scanner-status" role="status">Starting camera…</p>
                <div class="scan-result" id="scan-result" hidden aria-live="assertive"></div>
            </div>
        </section>`;
}

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
    result.innerHTML = `<p class="scan-title">Camera unavailable</p><p class="scan-line">${escapeHTML(message)}</p><div class="scan-actions"><button class="button button-primary" type="button" data-action="checkin-by-name">Check in by name</button><button class="button button-secondary" type="button" data-action="scanner-retry">Try again</button></div>`;
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

function reminderLink(data) {
    const member = data.member;
    const phone = welcomePhone(member?.phone);
    if (!member?.whatsapp_opt_in || !phone || !data.membership) return "";
    const template = state.whatsapp?.expiryReminderTemplate || "Hi {name}, your {plan} membership expires on {expiry_date}. We would love to see you again!";
    const text = template.replace(/\{(name|plan|expiry_date)\}/g, (_match, key) => ({ name: member.full_name, plan: data.membership.plan_name, expiry_date: formatDate(data.membership.end_date) })[key]);
    return `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
}

/** The big result card over the camera view. */
export function showResult(data) {
    const session = scanner;
    const box = scannerElement("#scan-result");
    if (!box) return;
    const name = data.member?.full_name || "";
    const firstName = name.split(/\s+/)[0] || "Member";
    const membership = data.membership;
    const left = membership?.days_left;
    const planLine = membership ? `${membership.plan_name}${left > 0 ? ` · ${left} day${left === 1 ? "" : "s"} left` : left === 0 ? " · last day today" : ""}` : "";
    let tone = "grey";
    let html = "";
    let duration = RESULT_MS;
    if (data.result === "checked_in") {
        tone = "green";
        vibrate(80);
        html = `<p class="scan-title">Welcome, ${escapeHTML(firstName)} ✓</p><p class="scan-line">Checked in ${escapeHTML(timeText(data.attendance?.checked_in_at))}</p>${planLine ? `<p class="scan-sub">${escapeHTML(planLine)}</p>` : ""}`;
    } else if (data.result === "already_checked_in") {
        tone = "amber";
        vibrate([60, 80, 60]);
        html = `<p class="scan-title">${escapeHTML(name)}</p><p class="scan-line">Already checked in today at ${escapeHTML(timeText(data.attendance?.checked_in_at))}</p>${planLine ? `<p class="scan-sub">${escapeHTML(planLine)}</p>` : ""}`;
    } else if (data.result === "expired" || data.result === "no_membership") {
        tone = "red";
        vibrate([200, 100, 200]);
        duration = ACTION_RESULT_MS;
        const ago = left < 0 ? -left : 0;
        const headline = data.result === "expired"
            ? `Membership expired ${ago === 1 ? "yesterday" : `${ago} days ago`}`
            : "No active membership";
        const remind = data.result === "expired" ? reminderLink(data) : "";
        html = `<p class="scan-title">${escapeHTML(name)}</p><p class="scan-line">${escapeHTML(headline)}</p><p class="scan-sub">Check-in recorded and flagged.</p>
            <div class="scan-actions">
                <button class="button button-primary" type="button" data-action="assign-member-plan" data-id="${escapeHTML(data.member.id)}" disabled>${data.result === "expired" ? "Renew" : "Assign plan"}</button>
                <button class="button button-secondary" type="button" data-action="record-payment" data-id="${escapeHTML(data.member.id)}" ${membership?.price ? `data-amount="${escapeHTML(String(membership.price))}"` : ""} disabled>Record payment</button>
                ${remind ? `<a class="button button-whatsapp" href="${escapeHTML(remind)}" target="_blank" rel="noopener noreferrer">Remind on WhatsApp</a>` : ""}
                <button class="button button-secondary" type="button" data-action="scanner-continue">Continue scanning</button>
            </div>`;
        // Renew and Record payment work on a member loaded in this browser.
        ensureMemberLoaded(data.member).then((member) => {
            if (member) box.querySelectorAll("[disabled]").forEach((button) => { button.disabled = false; });
        });
    } else if (data.result === "error") {
        vibrate(300);
        html = `<p class="scan-title">Couldn't check in</p><p class="scan-line">${escapeHTML(data.message || "Please try again.")}</p>`;
    } else {
        vibrate(300);
        html = `<p class="scan-title">QR not recognised</p><p class="scan-line">This is not a member QR for this gym.</p>`;
    }
    box.className = `scan-result scan-${tone}`;
    box.innerHTML = html;
    box.hidden = false;
    setStatus("");
    if (!session) return;
    session.showing = true;
    clearTimeout(session.hideTimer);
    session.hideTimer = setTimeout(() => hideResult(session), duration);
}

function hideResult(session) {
    if (session !== scanner) return;
    session.showing = false;
    const box = scannerElement("#scan-result");
    if (box) box.hidden = true;
    setStatus("Scanning…");
}

export function continueScanning() {
    if (scanner) {
        clearTimeout(scanner.hideTimer);
        hideResult(scanner);
    }
}

// ---------- Member card ----------

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
        toast(`Imported ${totals.imported} check-in${totals.imported === 1 ? "" : "s"}${totals.already_recorded ? `, ${totals.already_recorded} already recorded` : ""}${totals.skipped ? `, ${totals.skipped} skipped (removed members or repeats)` : ""}.`);
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
        case "scanner-retry": restartScanner(); return true;
        case "member-card": openMemberCard(element.dataset.id); return true;
        case "member-card-share": shareMemberCard(element); return true;
        case "member-card-print": printMemberCard(); return true;
        case "member-qr-reissue": confirmReissue(element.dataset.id); return true;
        case "member-qr-reissue-confirm": reissue(element.dataset.id, element); return true;
        case "import-browser-checkins": importBrowserCheckIns(element, onChange); return true;
        case "retry-visits": loadAttendanceFeed(onChange); return true;
        default: return false;
    }
}
