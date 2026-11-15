// Error tracking with Sentry, on only when SENTRY_DSN is set. Backend errors (HTTP 500s and
// crashes) and frontend errors (relayed by POST /api/client-errors, because the page may only
// talk to its own server) go to the same Sentry project.
// Before anything is sent: no request bodies, headers, cookies, query strings, IP addresses or
// users; paths have ids and tokens masked; text has phone numbers, emails, tokens and quoted
// text (where names usually appear) removed.
import { readFileSync } from "node:fs";
import { maskPath, scrubText, scrubValue } from "./scrub.js";

let sentry = null;

const scrub = (value) => scrubText(value, { quotes: true });

function scrubFrame(frame) {
    const { vars: _vars, ...kept } = frame || {};
    return kept;
}

function scrubBreadcrumb(breadcrumb) {
    if (!breadcrumb) return breadcrumb;
    const data = breadcrumb.data || {};
    // Requests to Supabase carry filters such as phone=eq.98765…; keep only method, path, status.
    if (["http", "fetch", "xhr"].includes(breadcrumb.category) || breadcrumb.type === "http") {
        return {
            ...breadcrumb,
            message: undefined,
            data: {
                ...(data.method ? { method: data.method } : {}),
                ...(data.url ? { url: maskPath(String(data.url).replace(/^https?:\/\/[^/]+/, "")) } : {}),
                ...(data.status_code ? { status_code: data.status_code } : {})
            }
        };
    }
    return { ...breadcrumb, message: scrub(breadcrumb.message), data: scrubValue(data, { quotes: true }) };
}

/** The event as it will be sent: personal data and secrets removed. Exported for tests. */
export function scrubEvent(event) {
    if (!event) return event;
    const scrubbed = { ...event };
    delete scrubbed.user;
    if (scrubbed.request) {
        scrubbed.request = {
            ...(scrubbed.request.method ? { method: scrubbed.request.method } : {}),
            ...(scrubbed.request.url ? { url: maskPath(String(scrubbed.request.url).replace(/^https?:\/\/[^/]+/, "")) } : {})
        };
    }
    if (scrubbed.message) scrubbed.message = typeof scrubbed.message === "string" ? scrub(scrubbed.message) : scrubValue(scrubbed.message, { quotes: true });
    if (scrubbed.transaction) scrubbed.transaction = maskPath(scrubbed.transaction);
    if (scrubbed.exception?.values) {
        scrubbed.exception = {
            ...scrubbed.exception,
            values: scrubbed.exception.values.map((value) => ({
                ...value,
                value: scrub(value.value),
                ...(value.stacktrace ? { stacktrace: { ...value.stacktrace, frames: (value.stacktrace.frames || []).map(scrubFrame) } } : {})
            }))
        };
    }
    if (scrubbed.breadcrumbs) scrubbed.breadcrumbs = scrubbed.breadcrumbs.map(scrubBreadcrumb);
    for (const key of ["extra", "contexts", "tags"]) {
        if (scrubbed[key]) scrubbed[key] = scrubValue(scrubbed[key], { quotes: true });
    }
    return scrubbed;
}

function release() {
    if (process.env.SENTRY_RELEASE) return process.env.SENTRY_RELEASE;
    if (process.env.RENDER_GIT_COMMIT) return `gympulse@${process.env.RENDER_GIT_COMMIT.slice(0, 12)}`;
    try {
        return `gympulse@${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}`;
    } catch {
        return undefined;
    }
}

/** Starts Sentry when a DSN is given. Tests pass their own transport. Returns whether it is on. */
export async function initMonitoring({ dsn = process.env.SENTRY_DSN, environment = process.env.NODE_ENV || "development", transport } = {}) {
    if (!dsn) return false;
    const Sentry = await import("@sentry/node");
    Sentry.init({
        dsn,
        environment,
        release: release(),
        sendDefaultPii: false,
        maxBreadcrumbs: 30,
        // Never attach the bodies of incoming requests (they hold names, phones, passwords).
        integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" })],
        beforeSend: scrubEvent,
        beforeSendTransaction: scrubEvent,
        beforeBreadcrumb: scrubBreadcrumb,
        ...(transport ? { transport } : {})
    });
    sentry = Sentry;
    return true;
}

export function monitoringEnabled() {
    return Boolean(sentry);
}

export function captureException(error, { tags } = {}) {
    sentry?.captureException(error, tags ? { tags } : undefined);
}

/** A browser error relayed by POST /api/client-errors (already size-checked). */
export function captureClientError({ message, stack, source, view, version }) {
    if (!sentry) return;
    sentry.captureEvent({
        level: "error",
        platform: "javascript",
        exception: { values: [{ type: "BrowserError", value: String(message || "Error in the browser") }] },
        tags: { side: "frontend", ...(view ? { view } : {}) },
        extra: { stack: stack || "", source: source || "" },
        ...(version ? { release: `gympulse-web@${version}` } : {})
    });
}

export async function flushMonitoring(timeout = 2000) {
    if (sentry) await sentry.flush(timeout);
}

await initMonitoring();
