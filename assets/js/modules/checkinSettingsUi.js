// Settings > Attendance: the gym's one check-in method, the expired-member policy, and for the
// entrance poster its printable A4 poster, "Replace poster QR" and the optional location check.
// Only the owner can change these; other logins see them read-only.
import { state } from "../state.js";
import { apiClient } from "../api/apiClient.js";
import { openModal, closeModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { escapeHTML } from "../utils.js";
import { MAX_GRACE_DAYS } from "../checkin.js";
import { checkinSettings, canEditCheckinSettings } from "./checkinMethod.js";
import { qrSvg } from "./upiPayments.js";

export { checkinSettings };

export async function loadCheckinSettings() {
    if (checkinSettings.status === "loading") return checkinSettings;
    checkinSettings.status = "loading";
    try {
        const response = await apiClient.get("/api/gym-settings/attendance");
        checkinSettings.data = response?.data || null;
        checkinSettings.status = "ready";
        checkinSettings.message = "";
    } catch (error) {
        checkinSettings.status = "error";
        checkinSettings.message = error.message || "Check-in settings could not be loaded.";
    }
    return checkinSettings;
}

export function posterUrl() {
    const path = checkinSettings.data?.entrance_path;
    return path ? `${window.location.origin}${path}` : "";
}

const METHODS = [
    ["member_qr", "Member QR card", "Members show their QR card, staff scan it"],
    ["entrance_poster", "Entrance poster", "Members scan a QR poster at the entrance with their phone"]
];
const POLICIES = [
    ["warn", "Allow with warning", "The check-in is recorded and flagged for staff."],
    ["block", "Block check-in", "Not recorded. The member is asked to renew at the desk."]
];

function choice(name, [value, title, description], selected) {
    return `<label class="choice-card"><input type="radio" name="${name}" value="${value}" ${selected === value ? "checked" : ""} required><span><strong>${escapeHTML(title)}</strong><small>${escapeHTML(description)}</small></span></label>`;
}

function locationText(latitude, longitude, accuracy) {
    if (latitude === null || latitude === undefined || latitude === "") return "Not set";
    return `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}${accuracy ? ` (±${Math.round(accuracy)} m)` : ""}`;
}

function renderPosterOptions(data) {
    const url = posterUrl();
    let qr = "";
    try {
        qr = qrSvg(url, "Entrance poster QR code");
    } catch {
        qr = `<p class="helper-text">The QR could not be drawn. Reload the page.</p>`;
    }
    return `<div class="field full poster-panel">
            <div class="poster-preview">${qr}</div>
            <div class="poster-copy"><h3>Entrance poster</h3><p class="helper-text">Print it and put it up at the entrance. Members scan it with their phone camera; the first time, staff approve their phone.</p>
                <p class="poster-link"><span class="sr-only">Poster link: </span><code>${escapeHTML(url)}</code></p>
                <div class="button-row"><button class="button button-primary" type="button" data-action="print-poster">Print poster</button><button class="button button-secondary" type="button" data-action="replace-poster">Replace poster QR</button></div>
            </div>
        </div>
        <div class="field full"><label class="checkbox-line"><input type="checkbox" name="entrance_require_location" ${data.entrance_require_location ? "checked" : ""}> Only allow check-in near the gym</label><span class="helper-text">The member's phone shares its location when they tap Check in. Phones report their own location, so this stops casual check-ins from home rather than proving someone is there.</span></div>
        <div class="field"><label for="location-radius">Allowed distance (metres)</label><input id="location-radius" name="location_radius_m" type="number" min="25" max="2000" step="5" value="${Number(data.location_radius_m) || 150}"></div>
        <div class="field"><span class="field-label">Gym location</span><p class="location-value" id="gym-location-text">${escapeHTML(locationText(data.latitude, data.longitude))}</p>
            <input type="hidden" name="latitude" value="${data.latitude ?? ""}"><input type="hidden" name="longitude" value="${data.longitude ?? ""}">
            <button class="button button-secondary button-small" type="button" data-action="use-current-location">Use my current location</button>
            <span class="helper-text">Do this standing inside the gym.</span>
            <span class="helper-text field-error" id="location-error" role="alert" hidden></span></div>`;
}

export function renderAttendanceSettings() {
    const heading = `<h2>Attendance</h2><p class="helper-text">How members check in. Staff can always check a member in by hand.</p>`;
    if (state.sampleDataLoaded) return `<section class="card settings-section" id="attendance-settings">${heading}<p class="helper-text">Not available while sample data is loaded.</p></section>`;
    if (checkinSettings.status !== "ready" || !checkinSettings.data) {
        const body = checkinSettings.status === "error"
            ? `<div class="empty-state" role="alert"><p>${escapeHTML(checkinSettings.message)}</p><button class="button button-secondary" type="button" data-action="retry-checkin-settings">Try again</button></div>`
            : `<div class="empty-state" role="status">Loading check-in settings…</div>`;
        return `<section class="card settings-section" id="attendance-settings">${heading}${body}</section>`;
    }
    const data = checkinSettings.data;
    const editable = canEditCheckinSettings();
    return `<section class="card settings-section" id="attendance-settings">${heading}
        ${editable ? "" : `<div class="note-box" role="note">Only the gym owner can change these settings.</div>`}
        <form id="attendance-settings-form" class="form-grid" novalidate>
            <fieldset class="field full choice-group" ${editable ? "" : "disabled"}>
                <legend>Check-in method</legend>
                ${METHODS.map((method) => choice("checkin_method", method, data.checkin_method)).join("")}
                <span class="helper-text">Switching keeps every past visit; only new check-ins use the new method. The other method stops working at once.</span>
            </fieldset>
            <fieldset class="field full choice-group" ${editable ? "" : "disabled"}>
                <legend>Expired members</legend>
                ${POLICIES.map((policy) => choice("expired_checkin_policy", policy, data.expired_checkin_policy)).join("")}
            </fieldset>
            <fieldset class="field full plain-fieldset" ${editable ? "" : "disabled"}>
                <div class="field"><label for="grace-days">Grace period (days after expiry)</label><input id="grace-days" name="expiry_grace_days" type="number" min="0" max="${MAX_GRACE_DAYS}" step="1" inputmode="numeric" value="${Number(data.expiry_grace_days) || 0}"><span class="helper-text">During these days expired members can still check in, with a warning.</span></div>
            </fieldset>
            ${data.checkin_method === "entrance_poster"
                ? `<fieldset class="field full plain-fieldset poster-fieldset" ${editable ? "" : "disabled"}>${renderPosterOptions(data)}</fieldset>`
                : `<p class="field full helper-text">Choose "Entrance poster" and save to get the printable poster.</p>`}
            ${editable ? `<div class="field full"><span class="helper-text field-error" id="attendance-settings-error" role="alert" hidden></span><button class="button button-primary" type="submit">Save attendance settings</button></div>` : ""}
        </form>
    </section>`;
}

function showError(form, id, message) {
    const box = form.querySelector(`#${id}`) || document.querySelector(`#${id}`);
    if (!box) return toast(message, "error");
    box.textContent = message;
    box.hidden = !message;
}

export async function saveAttendanceSettings(form, onChange = () => {}) {
    const values = new FormData(form);
    const grace = Number(values.get("expiry_grace_days"));
    if (!Number.isInteger(grace) || grace < 0 || grace > MAX_GRACE_DAYS) return showError(form, "attendance-settings-error", `Grace period must be a whole number from 0 to ${MAX_GRACE_DAYS}.`);
    const body = {
        checkin_method: String(values.get("checkin_method") || ""),
        expired_checkin_policy: String(values.get("expired_checkin_policy") || ""),
        expiry_grace_days: grace
    };
    if (form.querySelector("[name=location_radius_m]")) {
        const radius = Number(values.get("location_radius_m"));
        if (!Number.isInteger(radius) || radius < 25 || radius > 2000) return showError(form, "attendance-settings-error", "The allowed distance must be 25 to 2000 metres.");
        const latitude = String(values.get("latitude") || "");
        const longitude = String(values.get("longitude") || "");
        body.entrance_require_location = values.get("entrance_require_location") === "on";
        body.location_radius_m = radius;
        body.latitude = latitude === "" ? null : Number(latitude);
        body.longitude = longitude === "" ? null : Number(longitude);
        if (body.entrance_require_location && body.latitude === null) return showError(form, "attendance-settings-error", "Tap \"Use my current location\" inside the gym before turning on the location check.");
    }
    showError(form, "attendance-settings-error", "");
    const button = form.querySelector("[type=submit]");
    if (button) button.disabled = true;
    try {
        const previous = checkinSettings.data?.checkin_method;
        const response = await apiClient.put("/api/gym-settings/attendance", body);
        checkinSettings.data = response?.data || checkinSettings.data;
        toast(previous && previous !== checkinSettings.data.checkin_method
            ? `Check-in method changed to ${checkinSettings.data.checkin_method === "member_qr" ? "member QR cards" : "the entrance poster"}. Past visits are kept.`
            : "Attendance settings saved.");
        onChange();
    } catch (error) {
        showError(form, "attendance-settings-error", error.message || "The settings could not be saved.");
        if (button?.isConnected) button.disabled = false;
    }
}

function useCurrentLocation(button) {
    const form = button.closest("form");
    const fail = (message) => showError(form, "location-error", message);
    if (!navigator.geolocation) return fail("This browser cannot share its location.");
    if (!window.isSecureContext) return fail("Location needs a secure (https) connection.");
    button.disabled = true;
    fail("");
    navigator.geolocation.getCurrentPosition((position) => {
        const { latitude, longitude, accuracy } = position.coords;
        form.querySelector("[name=latitude]").value = latitude.toFixed(6);
        form.querySelector("[name=longitude]").value = longitude.toFixed(6);
        form.querySelector("#gym-location-text").textContent = `${locationText(latitude, longitude, accuracy)} · save to keep it`;
        button.disabled = false;
    }, (error) => {
        button.disabled = false;
        fail(error.code === error.PERMISSION_DENIED
            ? "Location access is blocked. Allow location for this site in your browser settings, then try again."
            : "Your location could not be found. Move near a window and try again.");
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

function confirmReplacePoster() {
    openModal({
        title: "Replace poster QR?",
        body: `<p class="confirm-copy"><strong>Every printed poster with the current QR stops working at once.</strong> Phones that are already approved stay linked; members just scan the new poster. Use this if a photo of the poster is being used from outside the gym.</p>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-danger" type="button" data-action="replace-poster-confirm">Replace poster QR</button>`
    });
}

async function replacePoster(button, onChange) {
    if (button) button.disabled = true;
    try {
        const response = await apiClient.post("/api/gym-settings/attendance/replace-poster", {});
        checkinSettings.data = response?.data || checkinSettings.data;
        closeModal();
        toast("New poster QR ready. Print it and replace the old poster.");
        onChange();
    } catch (error) {
        toast(error.message || "The poster QR could not be replaced.", "error");
        if (button?.isConnected) button.disabled = false;
    }
}

// Short instructions on the poster, in English, Hindi and Marathi.
const POSTER_STEPS = [
    ["en", "Scan with your phone camera", ["First time: enter your mobile number, then ask the front desk to approve your phone.", "After that: scan and tap Check in."]],
    ["hi", "अपने फ़ोन के कैमरे से स्कैन करें", ["पहली बार: अपना मोबाइल नंबर डालें, फिर रिसेप्शन से अपना फ़ोन अप्रूव करवाएँ।", "उसके बाद: स्कैन करें और Check in दबाएँ।"]],
    ["mr", "तुमच्या फोनच्या कॅमेऱ्याने स्कॅन करा", ["पहिल्यांदा: तुमचा मोबाईल नंबर टाका, मग रिसेप्शनकडून फोन मंजूर करून घ्या.", "त्यानंतर: स्कॅन करा आणि Check in दाबा."]]
];

function printPoster() {
    const url = posterUrl();
    if (!url) return;
    let qr;
    try {
        qr = qrSvg(url, "Scan to check in");
    } catch (error) {
        return toast(error.message, "error");
    }
    const popup = window.open("", "_blank");
    if (!popup) return toast("Allow pop-ups to print the poster.", "error");
    popup.opener = null;
    const gymName = escapeHTML(state.gym.name || "Our gym");
    popup.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Check-in poster · ${gymName}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anek+Latin:wght@700;800&family=Mukta:wght@400;600;700&display=swap">
<style>
@page{size:A4 portrait;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font-family:Mukta,"Nirmala UI","Noto Sans Devanagari",Arial,sans-serif;color:#1E2D3A;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{width:210mm;height:297mm;padding:16mm 16mm 12mm;display:flex;flex-direction:column;align-items:center;text-align:center;border-top:6mm solid #F4A51C}
.gym{font-family:"Anek Latin",Mukta,sans-serif;font-weight:800;font-size:15mm;line-height:1.05;margin:0 0 3mm}
.cta{font-family:"Anek Latin",Mukta,sans-serif;font-weight:800;font-size:22mm;line-height:1;margin:0 0 7mm}
.qr{width:120mm;height:120mm;padding:4mm;border:1.2mm solid #1E2D3A;border-radius:6mm}
.qr svg{width:100%;height:100%;display:block}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:5mm;margin-top:9mm;width:100%;text-align:left}
.step{border-top:1.2mm solid #F4A51C;padding-top:3mm}
.step h2{font-size:5.2mm;line-height:1.2;margin:0 0 2mm}
.step p{font-size:4.1mm;line-height:1.35;margin:0 0 1.5mm}
.foot{margin-top:auto;font-size:3.4mm;color:#5B6B78}
</style></head><body><div class="sheet">
<p class="gym">${gymName}</p>
<p class="cta">Scan to check in</p>
<div class="qr">${qr}</div>
<div class="steps">${POSTER_STEPS.map(([lang, title, lines]) => `<div class="step" lang="${lang}"><h2>${escapeHTML(title)}</h2>${lines.map((line) => `<p>${escapeHTML(line)}</p>`).join("")}</div>`).join("")}</div>
<p class="foot">No QR scanner? Ask at the front desk.</p>
</div></body></html>`);
    popup.document.close();
    const print = () => { popup.focus(); popup.print(); };
    const fonts = popup.document.fonts;
    if (fonts?.ready) Promise.race([fonts.ready, new Promise((resolve) => setTimeout(resolve, 2500))]).then(print);
    else setTimeout(print, 500);
}

/** Settings > Attendance buttons. Returns true when the action was handled. */
export function handleCheckinSettingsAction(action, element, onChange) {
    switch (action) {
        case "print-poster": printPoster(); return true;
        case "replace-poster": confirmReplacePoster(); return true;
        case "replace-poster-confirm": replacePoster(element, onChange); return true;
        case "use-current-location": useCurrentLocation(element); return true;
        case "retry-checkin-settings": loadCheckinSettings().then(onChange); return true;
        default: return false;
    }
}
