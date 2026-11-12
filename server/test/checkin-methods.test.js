// One check-in method per gym, the expired-member policy, the entrance poster page (linking
// phones, approvals, check-in, rate limits) and the manual "last 4 digits" search.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { fakeCheckinDb, gymA, gymB, ids, owner } from "./helpers/fakeCheckinDb.js";
import { manualCheckIn, scanCheckIn, searchCheckInMembers } from "../services/attendanceService.js";
import { approveDevice, hashDeviceSecret, matchCode, newDeviceSecret, rejectDevice, requestLink, revokeDevice, entranceCheckIn } from "../services/entranceService.js";
import { gymForEntranceToken } from "../services/checkinSettingsService.js";
import { createEntranceRouter, ASKED_COOKIE, DEVICE_COOKIE, NOT_ACTIVE } from "../routes/entrance.js";
import { createEntranceLimits, createNumberLockout, validateCheckinSettings } from "../middleware/validateCheckin.js";
import { requireOwner } from "../middleware/requireOwner.js";
import { checkInOutcome, checkInStatus, distanceMeters, normalizeIndianMobile, withinRadius } from "../../assets/js/checkin.js";

// 07:42 IST on 12 Nov 2026.
const morning = new Date("2026-11-12T02:12:00Z");
const gymOf = (db, id) => db.tables.gyms.find((gym) => gym.id === id);
const tokenOf = (db, id) => db.tables.members.find((member) => member.id === id).qr_token;
const posterDb = (values = {}) => fakeCheckinDb({ gyms: { a: { checkin_method: "entrance_poster", ...values }, b: { checkin_method: "entrance_poster" } } });

/** Links a phone for the member(s) with this number and approves every request. */
async function approvedPhone(db, gymId, phone) {
    const secret = newDeviceSecret();
    await requestLink(gymOf(db, gymId), secret, phone, { now: morning }, db);
    for (const row of db.tables.member_devices.filter((device) => device.device_secret_hash === hashDeviceSecret(secret))) {
        await approveDevice(row.id, gymId, owner, db, morning);
    }
    return secret;
}

// ---------- Shared rules ----------

test("mobile numbers are normalised; distances and the radius allowance are in metres", () => {
    for (const input of ["9876543210", "+91 98765 43210", "+91-98765-43210", "098765 43210", "919876543210"]) assert.equal(normalizeIndianMobile(input), "9876543210", input);
    for (const input of ["12345", "5876543210", "98765432101", "98765abc10", ""]) assert.equal(normalizeIndianMobile(input), null, input);
    // About 111 m per 0.001° of latitude.
    assert.ok(Math.abs(distanceMeters(18.52, 73.85, 18.521, 73.85) - 111) < 1);
    const gym = { latitude: 18.52, longitude: 73.85, location_radius_m: 150 };
    assert.equal(withinRadius(gym, { latitude: 18.521, longitude: 73.85, accuracy: 10 }).ok, true);
    assert.equal(withinRadius(gym, { latitude: 18.5218, longitude: 73.85, accuracy: 10 }).ok, false, "about 200 m away");
    assert.equal(withinRadius(gym, { latitude: 18.5018, longitude: 73.85, accuracy: 3000 }).ok, false, "a vague fix adds at most 50 m");
    assert.equal(withinRadius(gym, { latitude: 18.5217, longitude: 73.85, accuracy: 60 }).ok, true, "189 m: inside 150 m plus the 50 m allowance");
});

test("grace days and the warn/block policy decide what is recorded", () => {
    const expired = (end) => ({ effective_status: "expired", end_date: end });
    assert.deepEqual(checkInStatus(expired("2026-11-09"), "2026-11-12", 3), { status: "grace", graceDaysLeft: 0 });
    assert.deepEqual(checkInStatus(expired("2026-11-10"), "2026-11-12", 3), { status: "grace", graceDaysLeft: 1 });
    assert.deepEqual(checkInStatus(expired("2026-11-08"), "2026-11-12", 3), { status: "expired" });
    assert.deepEqual(checkInStatus(expired("2026-11-11"), "2026-11-12", 0), { status: "expired" });
    assert.deepEqual(checkInStatus(null, "2026-11-12", 3), { status: "none" });
    assert.deepEqual(checkInStatus({ effective_status: "upcoming" }, "2026-11-12"), { status: "upcoming" });
    for (const status of ["active", "grace"]) assert.equal(checkInOutcome(status, "block").recorded, true, status);
    for (const status of ["expired", "none", "upcoming"]) {
        assert.equal(checkInOutcome(status, "warn").recorded, true, `${status} warn`);
        assert.deepEqual([checkInOutcome(status, "block").recorded, checkInOutcome(status, "block").blocked], [false, true], `${status} block`);
    }
});

// ---------- Only the chosen method ----------

test("only the gym's chosen method is accepted; manual works with both", async () => {
    const qrGym = fakeCheckinDb();
    assert.equal((await scanCheckIn(tokenOf(qrGym, ids.riya), gymA, owner, qrGym, morning)).result, "checked_in");
    assert.equal(await gymForEntranceToken(gymOf(qrGym, gymA).entrance_token, qrGym), null, "the poster is off for a member-QR gym");

    const posterGym = posterDb();
    await assert.rejects(scanCheckIn(tokenOf(posterGym, ids.riya), gymA, owner, posterGym, morning), (error) => error.status === 409 && /switched off/.test(error.message));
    assert.equal(posterGym.tables.attendance.length, 0);
    assert.equal((await gymForEntranceToken(gymOf(posterGym, gymA).entrance_token, posterGym)).id, gymA);
    assert.equal((await manualCheckIn(ids.riya, gymA, owner, posterGym, morning)).result, "checked_in");
    assert.equal(posterGym.tables.attendance[0].method, "manual");
});

test("only the owner can change check-in settings, and the values are checked", () => {
    const run = (middleware, request) => {
        const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        let passed = false;
        middleware(request, response, () => { passed = true; });
        return { passed, response };
    };
    for (const role of ["staff", "admin", null]) {
        const { passed, response } = run(requireOwner, { gymRole: role });
        assert.equal(passed, false, String(role));
        assert.equal(response.statusCode, 403);
    }
    assert.equal(run(requireOwner, { gymRole: "owner" }).passed, true);
    const valid = { checkin_method: "entrance_poster", expired_checkin_policy: "block", expiry_grace_days: 3, entrance_require_location: true, latitude: 18.52, longitude: 73.85, location_radius_m: 150 };
    assert.equal(run(validateCheckinSettings, { body: valid }).passed, true);
    for (const body of [
        { checkin_method: "kiosk" }, { expired_checkin_policy: "ignore" }, { expiry_grace_days: 61 }, { expiry_grace_days: -1 },
        { location_radius_m: 10 }, { latitude: 18.5 }, { latitude: 95, longitude: 73 }, { entrance_token: "mine" }, {}
    ]) assert.equal(run(validateCheckinSettings, { body }).passed, false, JSON.stringify(body));
});

// ---------- Grace period and warn/block ----------

test("expired within grace is allowed with the days left; beyond grace follows warn or block", async () => {
    const warn = fakeCheckinDb({ gyms: { a: { expiry_grace_days: 3 } } });
    // Dev's plan ended 9 Nov: 3 days ago on 12 Nov, the last grace day.
    const grace = await scanCheckIn(tokenOf(warn, ids.dev), gymA, owner, warn, morning);
    assert.deepEqual([grace.result, grace.recorded, grace.grace_days_left, grace.status], ["grace", true, 0, "grace"]);
    const nextDay = new Date("2026-11-13T02:12:00Z");
    const beyond = await scanCheckIn(tokenOf(warn, ids.dev), gymA, owner, warn, nextDay);
    assert.deepEqual([beyond.result, beyond.recorded, beyond.blocked], ["expired", true, false]);
    assert.deepEqual(warn.tables.attendance.map((row) => row.membership_status_at_check_in), ["grace", "expired"]);
    assert.equal(beyond.renewal_price, 1200, "renewal at the plan's current price");

    const block = fakeCheckinDb({ gyms: { a: { expired_checkin_policy: "block" } } });
    const blocked = await scanCheckIn(tokenOf(block, ids.dev), gymA, owner, block, morning);
    assert.deepEqual([blocked.result, blocked.recorded, blocked.blocked, blocked.attendance], ["expired", false, true, null]);
    const none = await manualCheckIn(ids.neha, gymA, owner, block, morning);
    assert.deepEqual([none.result, none.blocked], ["no_membership", true], "manual check-ins follow the policy too");
    assert.equal(block.tables.attendance.length, 0, "blocked check-ins are not stored");
    assert.equal((await scanCheckIn(tokenOf(block, ids.riya), gymA, owner, block, morning)).result, "checked_in", "active members are never blocked");
});

test("a plan that starts later is amber: recorded under warn, refused under block", async () => {
    const memberships = [{ id: "ms-dev-next", gym_id: gymA, member_id: ids.dev, plan_id: null, plan_name: "Quarterly", price: 3000, start_date: "2026-11-20", end_date: "2027-02-17", status: "assigned", created_at: "2026-11-10" }];
    const warn = fakeCheckinDb({ memberships });
    const upcoming = await scanCheckIn(tokenOf(warn, ids.dev), gymA, owner, warn, morning);
    assert.deepEqual([upcoming.result, upcoming.recorded, upcoming.membership.start_date], ["upcoming", true, "2026-11-20"]);
    const block = fakeCheckinDb({ memberships, gyms: { a: { expired_checkin_policy: "block" } } });
    assert.deepEqual([(await scanCheckIn(tokenOf(block, ids.dev), gymA, owner, block, morning)).blocked, block.tables.attendance.length], [true, 0]);
});

test("a member already checked in today is told so even after the policy turns to block", async () => {
    const db = fakeCheckinDb();
    await scanCheckIn(tokenOf(db, ids.dev), gymA, owner, db, morning);
    gymOf(db, gymA).expired_checkin_policy = "block";
    const again = await scanCheckIn(tokenOf(db, ids.dev), gymA, owner, db, new Date("2026-11-12T10:00:00Z"));
    assert.equal(again.result, "already_checked_in");
    assert.equal(again.attendance.checked_in_at, morning.toISOString());
});

// ---------- The entrance poster: services ----------

test("a family number links every member on it; the phone then asks who is checking in", async () => {
    const db = posterDb();
    const secret = await approvedPhone(db, gymA, "+91 91234 03210");
    assert.deepEqual(db.tables.member_devices.map((row) => [row.member_id, row.status]).sort(), [[ids.kabir, "approved"], [ids.meera, "approved"]].sort());
    const gym = gymOf(db, gymA);
    const choose = await entranceCheckIn(gym, secret, { now: morning }, db);
    assert.equal(choose.result, "choose");
    assert.deepEqual(choose.members.map((member) => member.first_name).sort(), ["Kabir", "Meera"], "first names only");
    const meera = choose.members.find((member) => member.first_name === "Meera");
    const result = await entranceCheckIn(gym, secret, { memberRef: meera.ref, now: morning }, db);
    assert.deepEqual([result.result, result.first_name, result.membership.plan_name], ["checked_in", "Meera", "Monthly"]);
    assert.equal(Object.hasOwn(result, "member"), false, "the member's phone never sees the full record");
    const row = db.tables.attendance[0];
    assert.deepEqual([row.member_id, row.method, row.member_device_id, row.recorded_by], [ids.meera, "entrance_poster", meera.ref, null]);
});

test("pending, rejected and revoked phones cannot check in", async () => {
    const db = posterDb();
    const gym = gymOf(db, gymA);
    const secret = newDeviceSecret();
    await requestLink(gym, secret, "9876543210", { now: morning }, db);
    const [pending] = db.tables.member_devices;
    assert.equal(pending.status, "pending");
    assert.equal(pending.device_secret_hash, hashDeviceSecret(secret), "only the hash is stored");
    assert.equal(JSON.stringify(db.tables.member_devices).includes(secret), false);
    await assert.rejects(entranceCheckIn(gym, secret, { now: morning }, db), (error) => error.status === 403 && error.data.result === "not_linked");

    await rejectDevice(pending.id, gymA, db);
    assert.equal(db.tables.member_devices.length, 0, "a rejected request is deleted");
    await assert.rejects(entranceCheckIn(gym, secret, { now: morning }, db), (error) => error.status === 403);

    const approved = await approvedPhone(db, gymA, "9876543210");
    assert.equal((await entranceCheckIn(gym, approved, { now: morning }, db)).result, "checked_in");
    await revokeDevice(db.tables.member_devices[0].id, gymA, owner, db, morning);
    await assert.rejects(entranceCheckIn(gym, approved, { now: new Date("2026-11-13T02:00:00Z") }, db), (error) => error.status === 403);
    await assert.rejects(approveDevice(db.tables.member_devices[0].id, gymA, owner, db), (error) => error.status === 404, "a revoked phone is not re-approved without a new request");
});

test("one gym's poster or phone never checks in another gym's member", async () => {
    const db = posterDb();
    // Riya's phone is approved at gym A.
    const secret = await approvedPhone(db, gymA, "9876543210");
    await assert.rejects(entranceCheckIn(gymOf(db, gymB), secret, { now: morning }, db), (error) => error.status === 403, "not linked at gym B");
    // Aisha (gym B) typing her number at gym A's poster creates nothing.
    await requestLink(gymOf(db, gymA), newDeviceSecret(), "9876543212", { now: morning }, db);
    assert.equal(db.tables.member_devices.some((row) => row.member_id === ids.aisha), false);
    // Staff of gym B cannot approve or revoke gym A's links.
    await assert.rejects(revokeDevice(db.tables.member_devices[0].id, gymB, owner, db), (error) => error.status === 404);
    assert.equal(db.tables.member_devices[0].status, "approved");
    assert.equal(db.tables.attendance.length, 0);
});

test("the location check uses the gym's radius, and asks when no position is sent", async () => {
    const db = posterDb({ entrance_require_location: true, latitude: 18.52, longitude: 73.85, location_radius_m: 150 });
    const gym = gymOf(db, gymA);
    const secret = await approvedPhone(db, gymA, "9876543210");
    assert.equal((await entranceCheckIn(gym, secret, { now: morning }, db)).result, "location_needed");
    const far = await entranceCheckIn(gym, secret, { location: { latitude: 18.53, longitude: 73.85, accuracy: 20 }, now: morning }, db);
    assert.deepEqual([far.result, far.radius_m], ["too_far", 150]);
    assert.ok(far.distance_m > 1000);
    assert.equal(db.tables.attendance.length, 0);
    assert.equal((await entranceCheckIn(gym, secret, { location: { latitude: 18.5205, longitude: 73.8504, accuracy: 15 }, now: morning }, db)).result, "checked_in");
});

test("an expired member's phone gets the renewal price and the gym's UPI details", async () => {
    const db = posterDb({ expired_checkin_policy: "block" });
    const secret = await approvedPhone(db, gymA, "9876543211");
    const result = await entranceCheckIn(gymOf(db, gymA), secret, { now: morning }, db);
    assert.deepEqual([result.result, result.blocked, result.recorded, result.first_name], ["expired", true, false, "Dev"]);
    assert.deepEqual(result.renewal, { amount: 1200, upi_id: "powergym@okicici", payee_name: "Power Gym", gym_name: "Power Gym", plan_name: "Monthly" });
    assert.equal(result.membership.end_date, "2026-11-09");
});

test("one poster check-in per member per day, either side of midnight IST", async () => {
    const db = posterDb();
    const gym = gymOf(db, gymA);
    const secret = await approvedPhone(db, gymA, "9876543210");
    assert.equal((await entranceCheckIn(gym, secret, { now: new Date("2026-11-12T18:29:00Z") }, db)).result, "checked_in");
    assert.equal((await entranceCheckIn(gym, secret, { now: new Date("2026-11-12T18:29:30Z") }, db)).result, "already_checked_in");
    assert.equal((await entranceCheckIn(gym, secret, { now: new Date("2026-11-12T18:31:00Z") }, db)).result, "checked_in");
    assert.deepEqual(db.tables.attendance.map((row) => row.check_in_date), ["2026-11-12", "2026-11-13"]);
});

// ---------- The entrance poster: the public page over HTTP ----------

async function startEntrance(db, options = {}) {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use("/c", createEntranceRouter({ client: db, minLinkMs: 120, now: () => morning, ...options }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A tiny browser: keeps cookies per path, sends Origin like a same-origin page would. */
function phone(base, ip = "203.0.113.10") {
    const jar = new Map();
    return {
        jar,
        async request(path, { method = "GET", body } = {}) {
            const cookies = [...jar.values()].filter((entry) => path === entry.path || path.startsWith(`${entry.path}/`)).map((entry) => `${entry.name}=${entry.value}`);
            const started = Date.now();
            const response = await fetch(`${base}${path}`, {
                method,
                headers: { "Content-Type": "application/json", Origin: base, "X-Forwarded-For": ip, ...(cookies.length ? { Cookie: cookies.join("; ") } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            const elapsed = Date.now() - started;
            const setCookies = response.headers.getSetCookie();
            for (const header of setCookies) {
                const [pair, ...attributes] = header.split("; ");
                const [name, value] = pair.split("=");
                const cookiePath = attributes.find((attribute) => attribute.startsWith("Path="))?.slice(5) || "/";
                jar.set(`${name}@${cookiePath}`, { name, value, path: cookiePath });
            }
            const text = await response.text();
            let json = null;
            try { json = JSON.parse(text); } catch { /* HTML */ }
            return { status: response.status, json, text, setCookies, elapsed };
        }
    };
}

test("the poster page answers a member's number and an unknown number identically", async () => {
    const db = posterDb();
    const token = gymOf(db, gymA).entrance_token;
    const { base, close } = await startEntrance(db);
    try {
        const member = phone(base, "203.0.113.11");
        const stranger = phone(base, "203.0.113.12");
        const page = await member.request(`/c/${token}`);
        assert.equal(page.status, 200);
        assert.match(page.text, /Power Gym/);
        assert.deepEqual((await member.request(`/c/${token}/state`)).json.data.state, "link");

        const known = await member.request(`/c/${token}/link`, { method: "POST", body: { phone: "9876543210" } });
        const unknown = await stranger.request(`/c/${token}/link`, { method: "POST", body: { phone: "9000000001" } });
        for (const reply of [known, unknown]) {
            assert.equal(reply.status, 200);
            assert.deepEqual(Object.keys(reply.json.data).sort(), ["code", "state"]);
            assert.equal(reply.json.data.state, "waiting");
            assert.match(reply.json.data.code, /^\d{4}$/);
            assert.ok(reply.elapsed >= 110, `took ${reply.elapsed} ms`);
            // Same cookies, same attributes: HttpOnly, SameSite=Lax, the device cookie on /c.
            const shape = reply.setCookies.map((header) => header.replace(/=[^;]*;/, "=…;"));
            assert.deepEqual(shape, [`${DEVICE_COOKIE}=…; Path=/c; Max-Age=34560000; HttpOnly; SameSite=Lax`, `${ASKED_COOKIE}=…; Path=/c/${token}; Max-Age=2592000; HttpOnly; SameSite=Lax`]);
        }
        assert.equal(Math.abs(known.elapsed - unknown.elapsed) < 100, true, `${known.elapsed} vs ${unknown.elapsed} ms`);
        // After a reload both phones still see the same waiting screen, with their own code.
        const knownState = (await member.request(`/c/${token}/state`)).json.data;
        const unknownState = (await stranger.request(`/c/${token}/state`)).json.data;
        assert.deepEqual([knownState.state, unknownState.state], ["waiting", "waiting"]);
        assert.deepEqual(Object.keys(knownState).sort(), Object.keys(unknownState).sort());
        // Only the member's request reached the staff list, with the code the phone shows.
        assert.equal(db.tables.member_devices.length, 1);
        assert.equal(matchCode(db.tables.member_devices[0].device_secret_hash), known.json.data.code);
        assert.equal(knownState.code, known.json.data.code);
    } finally {
        await close();
    }
});

test("an approved phone checks in with one tap; unknown or switched-off posters are not active", async () => {
    const db = posterDb();
    const token = gymOf(db, gymA).entrance_token;
    const { base, close } = await startEntrance(db);
    try {
        const riya = phone(base);
        await riya.request(`/c/${token}/link`, { method: "POST", body: { phone: "98765 43210" } });
        const early = await riya.request(`/c/${token}/checkin`, { method: "POST", body: {} });
        assert.deepEqual([early.status, early.json.data.result], [403, "not_linked"]);
        await approveDevice(db.tables.member_devices[0].id, gymA, owner, db, morning);
        const ready = (await riya.request(`/c/${token}/state`)).json.data;
        assert.deepEqual([ready.state, ready.members.map((member) => member.first_name)], ["ready", ["Riya"]]);
        const done = await riya.request(`/c/${token}/checkin`, { method: "POST", body: {} });
        assert.deepEqual([done.status, done.json.data.result, done.json.data.first_name], [200, "checked_in", "Riya"]);

        // Cross-site posts are refused (the cookie is SameSite=Lax, and the Origin is checked).
        const forged = await fetch(`${base}/c/${token}/checkin`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
        assert.equal(forged.status, 403);

        for (const path of [`/c/${"x".repeat(43)}`, "/c/short"]) {
            const page = await riya.request(path);
            assert.equal(page.status, 404);
            assert.match(page.text, new RegExp(NOT_ACTIVE));
        }
        gymOf(db, gymA).checkin_method = "member_qr";
        assert.equal((await riya.request(`/c/${token}`)).status, 404, "a switched-off poster is not active");
        const off = await riya.request(`/c/${token}/checkin`, { method: "POST", body: {} });
        assert.deepEqual([off.status, off.json.message], [404, NOT_ACTIVE]);
    } finally {
        await close();
    }
});

test("a revoked phone is told so; any number entered afterwards shows the same waiting screen", async () => {
    const db = posterDb();
    const token = gymOf(db, gymA).entrance_token;
    let clock = morning;
    const later = (minutes) => { clock = new Date(clock.getTime() + minutes * 60000); return clock; };
    const { base, close } = await startEntrance(db, { now: () => clock });
    const deviceOf = (secretHash) => db.tables.member_devices.find((row) => row.device_secret_hash === secretHash);
    const hashOf = (handset) => hashDeviceSecret(handset.jar.get(`${DEVICE_COOKIE}@/c`).value);
    try {
        const first = phone(base, "203.0.113.21");
        const second = phone(base, "203.0.113.22");
        for (const handset of [first, second]) {
            await handset.request(`/c/${token}/link`, { method: "POST", body: { phone: "9876543210" } });
            await approveDevice(deviceOf(hashOf(handset)).id, gymA, owner, db, clock);
            assert.equal((await handset.request(`/c/${token}/state`)).json.data.state, "ready");
            // Revoked at the desk after the number was entered from this phone.
            await revokeDevice(deviceOf(hashOf(handset)).id, gymA, owner, db, later(30));
            assert.equal((await handset.request(`/c/${token}/state`)).json.data.state, "revoked");
        }

        // Afterwards, an unknown number and the member's own number look exactly alike.
        later(5);
        await first.request(`/c/${token}/link`, { method: "POST", body: { phone: "9000000001" } });
        await second.request(`/c/${token}/link`, { method: "POST", body: { phone: "9876543210" } });
        const unknown = (await first.request(`/c/${token}/state`)).json.data;
        const known = (await second.request(`/c/${token}/state`)).json.data;
        assert.deepEqual([unknown.state, known.state], ["waiting", "waiting"]);
        assert.deepEqual(Object.keys(unknown).sort(), Object.keys(known).sort());
        assert.equal(deviceOf(hashOf(second)).status, "pending", "the member's own number asks for approval again");
    } finally {
        await close();
    }
});

test("a number is locked for 15 minutes after 5 attempts, member or not", async () => {
    let clock = 1_000_000;
    const lockout = createNumberLockout();
    for (let attempt = 1; attempt <= 5; attempt += 1) assert.equal(lockout.attempt("9876543210", clock), true, `attempt ${attempt}`);
    assert.equal(lockout.attempt("9876543210", clock + 1000), false);
    assert.equal(lockout.attempt("9000000001", clock + 1000), true, "other numbers are not affected");
    clock += 15 * 60 * 1000 + 1;
    assert.equal(lockout.attempt("9876543210", clock), true, "unlocked after 15 minutes");

    const db = posterDb();
    const token = gymOf(db, gymA).entrance_token;
    const { base, close } = await startEntrance(db, { minLinkMs: 0 });
    try {
        for (const number of ["9876543210", "9000000001"]) {
            const statuses = [];
            for (let attempt = 0; attempt < 6; attempt += 1) {
                statuses.push((await phone(base, `198.51.100.${attempt + (number === "9876543210" ? 10 : 50)}`).request(`/c/${token}/link`, { method: "POST", body: { phone: number } })).status);
            }
            assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429], number);
        }
    } finally {
        await close();
    }
});

test("the poster page is rate limited per IP, per poster and per phone", async () => {
    const db = posterDb();
    const token = gymOf(db, gymA).entrance_token;
    const limits = createEntranceLimits({
        pageIp: { windowMs: 60000, limit: 50 },
        linkIp: { windowMs: 60000, limit: 2 },
        linkPoster: { windowMs: 60000, limit: 4 },
        checkinIp: { windowMs: 60000, limit: 50 },
        checkinPhone: { windowMs: 60000, limit: 2 }
    });
    const { base, close } = await startEntrance(db, { limits, minLinkMs: 0 });
    try {
        const sameIp = phone(base, "192.0.2.1");
        const ipStatuses = [];
        for (const number of ["9000000001", "9000000002", "9000000003"]) ipStatuses.push((await sameIp.request(`/c/${token}/link`, { method: "POST", body: { phone: number } })).status);
        assert.deepEqual(ipStatuses, [200, 200, 429], "per IP");
        const posterStatuses = [];
        for (const [index, number] of ["9000000004", "9000000005", "9000000006"].entries()) posterStatuses.push((await phone(base, `192.0.2.${10 + index}`).request(`/c/${token}/link`, { method: "POST", body: { phone: number } })).status);
        assert.deepEqual(posterStatuses, [200, 200, 429], "per poster: 4 in total across IPs");

        const secret = await approvedPhone(db, gymA, "9876543210");
        const tap = () => fetch(`${base}/c/${token}/checkin`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: `${DEVICE_COOKIE}=${secret}`, "X-Forwarded-For": "192.0.2.99" }, body: "{}" }).then((response) => response.status);
        assert.deepEqual([await tap(), await tap(), await tap()], [200, 200, 429], "per phone");
    } finally {
        await close();
    }
});

// ---------- Manual check-in search ----------

test("manual search matches the last 4 digits as typed, names, and puts usual-time members first", async () => {
    const db = fakeCheckinDb();
    // Kabir has come at about 7:30 AM IST on three recent days; Meera in the evening.
    for (const day of ["2026-11-09", "2026-11-10", "2026-11-11"]) {
        db.tables.attendance.push({ id: `k-${day}`, gym_id: gymA, member_id: ids.kabir, checked_in_at: `${day}T02:00:00.000Z`, check_in_date: day, method: "manual", membership_status_at_check_in: "active" });
        db.tables.attendance.push({ id: `m-${day}`, gym_id: gymA, member_id: ids.meera, checked_in_at: `${day}T13:00:00.000Z`, check_in_date: day, method: "manual", membership_status_at_check_in: "active" });
    }
    const names = async (query) => (await searchCheckInMembers(query, gymA, db, morning)).map((member) => member.full_name);
    assert.deepEqual(await names("3210"), ["Kabir Mehta", "Meera Mehta", "Riya Shah"], "ends in 3210; Kabir usually comes now");
    assert.deepEqual(await names("321"), ["Kabir Mehta", "Dev Rao", "Meera Mehta", "Neha Joshi", "Riya Shah"], "typed left to right: 3210, 3211, 3213");
    assert.deepEqual(await names("3211"), ["Dev Rao"]);
    assert.deepEqual(await names("9876543"), ["Dev Rao", "Neha Joshi", "Riya Shah"]);
    assert.deepEqual(await names("riya"), ["Riya Shah"]);
    assert.deepEqual(await names("GP-4"), ["Neha Joshi"]);
    assert.deepEqual(await names("3212"), [], "another gym's member is never listed");
    assert.deepEqual(await names(""), ["Kabir Mehta"], "with nothing typed: who usually comes at this time");
    const [kabir] = await searchCheckInMembers("3210", gymA, db, morning);
    assert.deepEqual([kabir.usually_now, kabir.phone_last4, Object.hasOwn(kabir, "phone")], [true, "3210", false]);
    await manualCheckIn(ids.riya, gymA, owner, db, morning);
    assert.equal((await searchCheckInMembers("riya", gymA, db, morning))[0].checked_in_today, true);
});
