// Sends errors that happen in the app to the server, which passes them to Sentry when
// SENTRY_DSN is set (the page may only talk to its own server). Only the error, where it
// happened in the code, the page name and the app version are sent; the server removes phone
// numbers, emails, tokens and quoted text before anything leaves it.
import { APP_VERSION } from "./version.js";

const MAX_REPORTS = 5;
const seen = new Set();
let sent = 0;
let currentView = () => "";

function send(report) {
    const key = `${report.message}|${report.source}`;
    if (sent >= MAX_REPORTS || seen.has(key)) return;
    seen.add(key);
    sent += 1;
    try {
        fetch("/api/client-errors", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(report),
            keepalive: true,
            credentials: "same-origin"
        }).catch(() => {});
    } catch {
        // Reporting must never cause another error.
    }
}

/** Reports one error. Errors the server already answered (a failed API request) are skipped. */
export function reportError(error, source = "") {
    if (!error || error.isApiError) return;
    const message = String(error.message || error).slice(0, 500);
    if (!message || /ResizeObserver loop|Script error\.?$/i.test(message)) return;
    const view = String(currentView() || "").replace(/[^a-z-]/g, "").slice(0, 40);
    send({
        message,
        ...(error.stack ? { stack: String(error.stack).slice(0, 4000) } : {}),
        ...(source ? { source: String(source).slice(0, 300) } : {}),
        ...(view ? { view } : {}),
        version: APP_VERSION
    });
}

export function startErrorReporting({ view } = {}) {
    if (typeof view === "function") currentView = view;
    window.addEventListener("error", (event) => {
        // Errors from browser extensions and other sites' scripts are not GymPulse's.
        if (event.filename && !event.filename.startsWith(window.location.origin)) return;
        reportError(event.error || event.message, event.filename ? `${event.filename.replace(window.location.origin, "")}:${event.lineno}:${event.colno}` : "");
    });
    window.addEventListener("unhandledrejection", (event) => reportError(event.reason, "promise"));
}
