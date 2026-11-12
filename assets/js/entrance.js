/* global qrcode */
// The entrance poster page (/c/<token>), on the member's own phone. No login: the phone is
// linked once (staff approve it) and then checks in with one tap. The phone's secret lives in an
// HttpOnly cookie the page cannot read; nothing is kept in browser storage.
import { buildUpiLink, upiNote } from "./upi.js";

const panel = document.querySelector("#panel");
const gymName = document.querySelector("#entry")?.dataset.gym || "";
const base = window.location.pathname.replace(/\/+$/, "");
let current = null;

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function rupees(amount) {
    const value = Number(amount);
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
}

function dateText(day) {
    return day ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)) : "";
}

function timeText(value) {
    return value ? new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "";
}

async function call(path, { method = "GET", body } = {}) {
    try {
        const response = await fetch(`${base}${path}`, {
            method,
            credentials: "same-origin",
            cache: "no-store",
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const json = await response.json().catch(() => ({}));
        return { status: response.status, data: json.data, message: json.message || "" };
    } catch {
        return { status: 0, data: null, message: "No connection. Check your internet and try again." };
    }
}

function show(html) {
    panel.innerHTML = html;
    const focus = panel.querySelector("[data-autofocus]");
    if (focus) focus.focus();
}

function notice(message, tone = "") {
    return message ? `<p class="notice ${tone}" role="alert">${escapeHTML(message)}</p>` : "";
}

// ---------- States ----------

function renderLink(message = "", { again = false } = {}) {
    show(`<form id="link-form" class="stack" novalidate>
        <h2>${again ? "Link this phone again" : "First time here?"}</h2>
        <p class="muted">Enter the mobile number you gave the gym. The front desk then approves this phone, once.</p>
        <label for="phone">Mobile number</label>
        <input id="phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="16" placeholder="98765 43210" required data-autofocus>
        ${notice(message, "error")}
        <button class="primary" type="submit">Continue</button>
    </form>`);
}

function renderWaiting(code, message = "") {
    show(`<div class="stack">
        <h2>Ask the front desk to approve this phone</h2>
        <p class="muted">Show them this code:</p>
        <p class="code" aria-label="Code ${escapeHTML(String(code).split("").join(" "))}">${escapeHTML(code)}</p>
        ${notice(message)}
        <button class="primary" type="button" data-action="refresh">I've been approved</button>
        <button class="link" type="button" data-action="link">Use a different number</button>
    </div>`);
}

function renderReady(state, message = "") {
    const members = state.members || [];
    if (members.length === 1) {
        show(`<div class="stack">
            <h2 class="hello">Hi ${escapeHTML(members[0].first_name)} 👋</h2>
            ${notice(message, "error")}
            <button class="primary huge" type="button" data-action="checkin" data-member="${escapeHTML(members[0].ref)}">Check in</button>
            <button class="link" type="button" data-action="link">Add another member on this phone</button>
        </div>`);
        return;
    }
    show(`<div class="stack">
        <h2>Who's checking in?</h2>
        ${notice(message, "error")}
        <div class="choices">${members.map((member) => `<button class="primary big" type="button" data-action="checkin" data-member="${escapeHTML(member.ref)}">${escapeHTML(member.first_name)}</button>`).join("")}</div>
        <button class="link" type="button" data-action="link">Add another member on this phone</button>
    </div>`);
}

function renderRevoked() {
    show(`<div class="stack">
        <h2>This phone is no longer linked</h2>
        <p class="muted">Ask at the front desk, or link it again with your mobile number.</p>
        <button class="primary" type="button" data-action="link-again">Link this phone</button>
    </div>`);
}

function renderInactive() {
    document.title = "Check-in link not active";
    show(`<div class="stack"><h2>This check-in link is not active</h2><p class="muted">Ask at the front desk for the current check-in poster.</p></div>`);
}

async function loadState(message = "") {
    const reply = await call("/state");
    if (reply.status === 404) return renderInactive();
    if (!reply.data) return show(`<div class="stack">${notice(reply.message || "Something went wrong.", "error")}<button class="primary" type="button" data-action="refresh">Try again</button></div>`);
    current = reply.data;
    if (current.state === "ready") return renderReady(current, message);
    if (current.state === "waiting") return renderWaiting(current.code, message);
    if (current.state === "revoked") return renderRevoked();
    return renderLink(message);
}

// ---------- Linking ----------

async function submitLink(form) {
    const button = form.querySelector("button[type=submit]");
    const phone = form.phone.value.trim();
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) return renderLink("Enter your 10-digit mobile number.");
    button.disabled = true;
    button.textContent = "Please wait…";
    const reply = await call("/link", { method: "POST", body: { phone } });
    if (reply.status === 404) return renderInactive();
    if (reply.status === 200 && reply.data?.state === "waiting") return renderWaiting(reply.data.code);
    renderLink(reply.message || "That did not work. Please try again.");
    const input = panel.querySelector("#phone");
    if (input) input.value = phone;
}

// ---------- Checking in ----------

function position() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(Object.assign(new Error("unsupported"), { code: -1 }));
        navigator.geolocation.getCurrentPosition(
            (result) => resolve({ latitude: result.coords.latitude, longitude: result.coords.longitude, accuracy: result.coords.accuracy }),
            reject,
            // Always a fresh position: after "too far", a member who walks closer and taps again
            // must not get the old cached one back.
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    });
}

function locationProblem(error) {
    if (error?.code === 1) return "Location is needed to check in here. Allow location for this site in your browser settings, then tap Check in again. Or check in at the front desk.";
    if (error?.code === -1) return "This browser cannot share its location. Please check in at the front desk.";
    return "Your location could not be found. Step near the entrance and try again, or check in at the front desk.";
}

async function checkIn(button) {
    const member = button.dataset.member;
    panel.querySelectorAll("button").forEach((item) => { item.disabled = true; });
    button.textContent = "Checking in…";
    const body = member ? { member } : {};
    if (current?.require_location) {
        try {
            button.textContent = "Finding your location…";
            body.location = await position();
        } catch (error) {
            return renderReady(current, locationProblem(error));
        }
    }
    const reply = await call("/checkin", { method: "POST", body });
    if (reply.status === 404) return renderInactive();
    if (reply.status === 403) return loadState(reply.message);
    if (reply.status !== 200 || !reply.data) return renderReady(current, reply.message || "Check-in did not work. Please try again.");
    const result = reply.data;
    if (result.result === "choose") return renderReady({ ...current, members: result.members });
    if (result.result === "location_needed") return renderReady({ ...current, require_location: true }, "Location is needed to check in here. Tap Check in and allow location.");
    if (result.result === "too_far") {
        const away = result.distance_m >= 1000 ? `${(result.distance_m / 1000).toFixed(1)} km` : `${result.distance_m} m`;
        return renderReady(current, `You seem to be about ${away} from the gym. Check in when you're at the entrance.`);
    }
    renderResult(result);
}

function qrSvg(text) {
    if (typeof qrcode !== "function") return "";
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let path = "";
    for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) if (qr.isDark(row, col)) path += `M${col + 4} ${row + 4}h1v1h-1z`;
    }
    return `<svg class="qr" viewBox="0 0 ${count + 8} ${count + 8}" role="img" aria-label="UPI payment QR code" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#1E2D3A"/></svg>`;
}

function renewalPanel(result) {
    const renewal = result.renewal;
    if (!renewal) return `<p class="muted">Please renew at the front desk.</p>`;
    const expired = result.membership?.end_date ? `Your plan expired on ${dateText(result.membership.end_date)}. ` : "";
    let link = "";
    try {
        if (renewal.upi_id) link = buildUpiLink({ upiId: renewal.upi_id, payeeName: renewal.payee_name, amount: renewal.amount, note: upiNote({ gymName: renewal.gym_name, planName: renewal.plan_name }) });
    } catch {
        link = "";
    }
    if (!link) return `<div class="renew"><p><strong>${escapeHTML(expired)}Renew now: ${escapeHTML(rupees(renewal.amount))}</strong></p><p class="muted">Please pay at the front desk.</p></div>`;
    return `<div class="renew">
        <p><strong>${escapeHTML(expired)}Renew now: ${escapeHTML(rupees(renewal.amount))}</strong></p>
        <a class="primary button-link" href="${escapeHTML(link)}">Open UPI app</a>
        <div class="qr-box">${qrSvg(link)}</div>
        <p class="muted small">Paying from another phone? Scan this QR. The front desk confirms your payment in GymPulse.</p>
    </div>`;
}

function renderResult(result) {
    const name = escapeHTML(result.first_name || "");
    const time = timeText(result.checked_in_at);
    const plan = result.membership ? `${result.membership.plan_name}${result.membership.days_left > 0 ? ` · ${result.membership.days_left} day${result.membership.days_left === 1 ? "" : "s"} left` : ""}` : "";
    let tone = "green";
    let html = "";
    if (result.result === "checked_in") {
        html = `<h2>You're checked in ✓</h2><p class="big-line">${escapeHTML(time)}</p>${plan ? `<p>${escapeHTML(plan)}</p>` : ""}<p>Have a good workout, ${name}!</p>`;
    } else if (result.result === "already_checked_in") {
        tone = "amber";
        html = `<h2>Already checked in today</h2><p class="big-line">at ${escapeHTML(time)}</p>${plan ? `<p>${escapeHTML(plan)}</p>` : ""}`;
        if (result.renewal) html += renewalPanel(result);
    } else if (result.result === "grace") {
        tone = "amber";
        html = `<h2>You're checked in</h2><p class="big-line">${escapeHTML(time)}</p><p>${result.grace_days_left > 0 ? `${result.grace_days_left} grace day${result.grace_days_left === 1 ? "" : "s"} left.` : "Today is your last grace day."}</p>${renewalPanel(result)}`;
    } else if (result.result === "upcoming") {
        tone = "amber";
        html = `<h2>${result.blocked ? "Not checked in" : "You're checked in"}</h2><p class="big-line">Your plan starts on ${escapeHTML(dateText(result.membership?.start_date))}</p>${result.blocked ? `<p>Please see the front desk.</p>` : ""}`;
    } else if (result.result === "expired") {
        tone = "red";
        html = `<h2>${result.blocked ? "Not checked in" : "Checked in, but your plan has expired"}</h2>${result.blocked ? `<p class="big-line">Please renew at the desk.</p>` : ""}${renewalPanel(result)}`;
    } else if (result.result === "no_membership") {
        tone = "red";
        html = `<h2>${result.blocked ? "Not checked in" : "Checked in"}</h2><p class="big-line">No active membership</p>${result.renewal ? renewalPanel(result) : `<p>Please see the front desk.</p>`}`;
    } else {
        tone = "grey";
        html = `<h2>Not recognised</h2><p>Please check in at the front desk.</p>`;
    }
    try {
        navigator.vibrate?.(tone === "green" ? 80 : tone === "red" ? [200, 100, 200] : [60, 80, 60]);
    } catch {
        // Vibration is optional.
    }
    show(`<div class="result result-${tone}" role="status">${html}</div><button class="link" type="button" data-action="refresh">Done</button>`);
}

// ---------- Events ----------

panel.addEventListener("submit", (event) => {
    if (event.target.id !== "link-form") return;
    event.preventDefault();
    submitLink(event.target);
});

panel.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "checkin") checkIn(button);
    else if (action === "refresh") loadState();
    else if (action === "link") renderLink();
    else if (action === "link-again") renderLink("", { again: true });
});

if (gymName) document.title = `Check in · ${gymName}`;
loadState();
