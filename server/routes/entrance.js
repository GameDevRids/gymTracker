import express from "express";
import { supabaseClient } from "../config/database.js";
import { logger } from "../config/logger.js";
import { readCookie, requireSameOrigin } from "../middleware/sessionCookie.js";
import {
    createEntranceLimits,
    createNumberLockout,
    validateEntranceCheckIn,
    validateLinkRequest
} from "../middleware/validateCheckin.js";
import { CheckinSettingsError, gymForEntranceToken } from "../services/checkinSettingsService.js";
import {
    DEVICE_SECRET_PATTERN,
    EntranceError,
    entranceCheckIn,
    entranceState,
    newDeviceSecret,
    requestLink
} from "../services/entranceService.js";
import { normalizeIndianMobile } from "../../assets/js/checkin.js";

// The public entrance poster page: /c/<entrance_token>. No login. Members link their phone once
// (staff approve it), then check in with one tap.

export const DEVICE_COOKIE = "gp_device";
export const ASKED_COOKIE = "gp_asked";
// Sent to every /c/ page, so replacing the poster link does not unlink every member's phone.
const DEVICE_COOKIE_PATH = "/c";
const DEVICE_COOKIE_DAYS = 400; // The longest browsers keep a cookie.
// Every link request takes at least this long, member's number or not.
export const LINK_MIN_MS = 700;
export const NOT_ACTIVE = "This check-in link is not active";

function cookie(request, name, value, { path, maxAgeSeconds }) {
    return [
        `${name}=${encodeURIComponent(value)}`,
        `Path=${path}`,
        `Max-Age=${maxAgeSeconds}`,
        "HttpOnly",
        "SameSite=Lax",
        ...(request.secure ? ["Secure"] : [])
    ].join("; ");
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export function entrancePage(gym) {
    const title = gym ? `Check in · ${gym.name}` : "Check-in link not active";
    const body = gym
        ? `<main class="entry" id="entry" data-gym="${escapeHTML(gym.name)}"><header><p class="gym">${escapeHTML(gym.name)}</p><h1>Check in</h1></header><section id="panel" aria-live="polite"><p class="muted">Loading…</p></section></main>
<noscript><p class="entry">Turn on JavaScript to check in, or ask at the front desk.</p></noscript>
<script src="/assets/vendor/qrcode-generator-1.4.4.js" defer></script>
<script type="module" src="/assets/js/entrance.js"></script>`
        : `<main class="entry"><header><h1>${NOT_ACTIVE}</h1></header><section><p class="muted">Ask at the front desk for the current check-in poster.</p></section></main>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${escapeHTML(title)}</title>
<link rel="stylesheet" href="/assets/css/entrance.css">
</head>
<body>
${body}
</body>
</html>`;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createEntranceRouter({
    client = supabaseClient,
    limits = createEntranceLimits(),
    lockout = createNumberLockout(),
    minLinkMs = LINK_MIN_MS,
    now = () => new Date()
} = {}) {
    const router = express.Router();

    async function activeGym(request) {
        return gymForEntranceToken(request.params.token, client);
    }

    function deviceSecret(request) {
        const value = readCookie(request, DEVICE_COOKIE);
        return DEVICE_SECRET_PATTERN.test(value) ? value : "";
    }

    function inactive(response) {
        return response.status(404).json({ status: "error", message: NOT_ACTIVE, data: { state: "inactive" } });
    }

    router.use((_request, response, next) => {
        response.set("Cache-Control", "no-store");
        response.set("X-Robots-Tag", "noindex");
        next();
    });

    router.get("/:token", limits.page, async (request, response, next) => {
        try {
            const gym = await activeGym(request);
            response.status(gym ? 200 : 404).type("html").send(entrancePage(gym));
        } catch (error) {
            next(error);
        }
    });

    router.get("/:token/state", limits.page, async (request, response, next) => {
        try {
            const gym = await activeGym(request);
            if (!gym) return inactive(response);
            // When a number was last entered from this phone (ms); 0 if never or unreadable.
            const askedAt = Number(readCookie(request, ASKED_COOKIE)) || 0;
            response.json({ status: "success", data: await entranceState(gym, deviceSecret(request), { askedAt }, client) });
        } catch (error) {
            next(error);
        }
    });

    // The same answer, cookies and minimum time for every number: a member's or not.
    router.post("/:token/link", requireSameOrigin, limits.linkIp, limits.linkPoster, validateLinkRequest, async (request, response, next) => {
        const started = Date.now();
        const settle = () => wait(Math.max(0, minLinkMs - (Date.now() - started)));
        try {
            const mobile = normalizeIndianMobile(request.linkPhone);
            if (!mobile) return response.status(400).json({ status: "error", message: "Enter your 10-digit mobile number." });
            const gym = await activeGym(request);
            if (!gym) {
                await settle();
                return inactive(response);
            }
            if (!lockout.attempt(mobile)) {
                await settle();
                return response.status(429).json({ status: "error", message: "Too many tries for this number. Try again in 15 minutes." });
            }
            const secret = deviceSecret(request) || newDeviceSecret();
            const result = await requestLink(gym, secret, mobile, { userAgent: request.get("User-Agent"), now: now() }, client);
            response.append("Set-Cookie", cookie(request, DEVICE_COOKIE, secret, { path: DEVICE_COOKIE_PATH, maxAgeSeconds: DEVICE_COOKIE_DAYS * 86400 }));
            response.append("Set-Cookie", cookie(request, ASKED_COOKIE, String(now().getTime()), { path: `/c/${request.params.token}`, maxAgeSeconds: 30 * 86400 }));
            await settle();
            response.json({ status: "success", data: result });
        } catch (error) {
            await settle();
            next(error);
        }
    });

    router.post("/:token/checkin", requireSameOrigin, limits.checkinIp, (request, _response, next) => {
        request.deviceSecret = deviceSecret(request);
        next();
    }, limits.checkinPhone, validateEntranceCheckIn, async (request, response, next) => {
        try {
            const gym = await activeGym(request);
            if (!gym) return inactive(response);
            const { member, location } = request.entranceCheckIn;
            const result = await entranceCheckIn(gym, request.deviceSecret, { memberRef: member || null, location: location || null, now: now() }, client);
            response.json({ status: "success", data: result });
        } catch (error) {
            next(error);
        }
    });

    router.use((error, _request, response, _next) => {
        const known = error instanceof EntranceError || error instanceof CheckinSettingsError;
        const status = known && Number.isInteger(error.status) ? error.status : 500;
        if (status === 500) logger.error({ err: error }, "Entrance check-in request failed.");
        response.status(status).json({
            status: "error",
            message: status === 500 ? "Check-in is not working right now. Please check in at the front desk." : error.message,
            ...(error.data ? { data: error.data } : {})
        });
    });

    return router;
}
