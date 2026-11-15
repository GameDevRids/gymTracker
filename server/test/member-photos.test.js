// Member photos: consent first, file checks by content, gym isolation, signed URLs, replacing,
// archiving, withdrawal, the entrance poster page (pending only) and staff review. Photos never
// reach the welcome card, member card, receipts or WhatsApp.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFileSync } from "node:fs";
import { gymA, gymB, ids, owner } from "./helpers/fakeCheckinDb.js";
import { fakePhotoDb, jpegBytes, webpBytes, PHOTO_BUCKET_NAME } from "./helpers/fakePhotos.js";
import { MAX_PHOTO_BYTES, preparePhoto } from "../services/photoFile.js";
import * as photos from "../services/memberPhotosService.js";
import { deleteMember } from "../services/membersService.js";
import { photoBody } from "../middleware/photoBody.js";
import { createEntranceRouter, DEVICE_COOKIE } from "../routes/entrance.js";
import { approveDevice, entranceCheckIn, hashDeviceSecret, newDeviceSecret, requestLink } from "../services/entranceService.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000100000001008020000", "hex");
const morning = new Date("2026-11-12T02:12:00Z");
const member = (db, id) => db.tables.members.find((row) => row.id === id);
const events = (db, id) => db.tables.member_consent_events.filter((event) => event.member_id === id);
const agree = (db, id, gymId = gymA) => photos.setPhotoConsent(id, gymId, { agree: true, source: "desk", recordedBy: owner }, db);
const status = (promise) => promise.then(() => 200, (error) => error.status);
const posterDb = (photo) => fakePhotoDb({ gyms: { a: { checkin_method: "entrance_poster" }, b: { checkin_method: "entrance_poster" } }, photo });

async function withPhoto(db, id, gymId = gymA) {
    await agree(db, id, gymId);
    await photos.uploadMemberPhoto(id, gymId, jpegBytes(), db);
    return member(db, id).photo_path;
}

// ---------- File checks ----------

test("only real JPEG or WebP images of at most 300 KB and 1024 px are accepted, judged by their bytes", () => {
    assert.equal(preparePhoto(jpegBytes()).type, "jpeg");
    assert.equal(preparePhoto(webpBytes()).type, "webp");
    const reject = (buffer, pattern) => assert.throws(() => preparePhoto(buffer), pattern);
    reject(PNG, /JPEG or WebP/);
    reject(Buffer.from("this is a text file named photo.jpg"), /JPEG or WebP/);
    reject(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"), /JPEG or WebP/);
    reject(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40)]), /JPEG or WebP/);
    reject(jpegBytes({ width: 4000, height: 3000 }), /at most 1024/);
    reject(Buffer.alloc(0), /Choose a photo/);
    const big = jpegBytes({ padTo: MAX_PHOTO_BYTES });
    assert.ok(big.length > MAX_PHOTO_BYTES);
    assert.throws(() => preparePhoto(big), (error) => error.status === 413);
});

test("location and other metadata are removed before a photo is stored", () => {
    const jpeg = preparePhoto(jpegBytes());
    assert.equal(jpeg.buffer.includes(Buffer.from("GPS")), false);
    assert.equal(jpeg.buffer.includes(Buffer.from("taken at home")), false);
    assert.deepEqual([jpeg.buffer[0], jpeg.buffer[1]], [0xff, 0xd8]);
    assert.deepEqual([jpeg.width, jpeg.height], [512, 512]);
    const webp = preparePhoto(webpBytes());
    assert.equal(webp.buffer.includes(Buffer.from("GPS")), false);
    assert.equal(webp.buffer.includes(Buffer.from("xmpmeta")), false);
    assert.equal(webp.buffer.readUInt32LE(4) + 8, webp.buffer.length, "RIFF size matches");
    assert.equal(webp.buffer[20] & 0x0c, 0, "EXIF and XMP flags cleared");
    assert.deepEqual([webp.width, webp.height], [400, 300]);
});

test("the upload body is read as bytes whatever its declared type, and over 300 KB is refused", async () => {
    const app = express();
    app.put("/photo", photoBody, (request, response) => {
        try {
            response.json({ type: preparePhoto(request.body).type });
        } catch (error) {
            response.status(error.status).json({ message: error.message });
        }
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/photo`;
    const put = (body, type) => fetch(url, { method: "PUT", headers: { "Content-Type": type }, body });
    try {
        assert.equal((await (await put(jpegBytes(), "application/octet-stream")).json()).type, "jpeg");
        const disguised = await put(PNG, "image/jpeg");
        assert.equal(disguised.status, 400);
        const tooBig = await put(Buffer.alloc(MAX_PHOTO_BYTES + 1, 1), "image/jpeg");
        assert.equal(tooBig.status, 413);
        assert.match((await tooBig.json()).message, /300 KB/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

// ---------- Consent ----------

test("a photo is never saved before the member agrees", async () => {
    const db = fakePhotoDb();
    await assert.rejects(photos.uploadMemberPhoto(ids.riya, gymA, jpegBytes(), db), (error) => error.status === 403 && /agreed/.test(error.message));
    assert.equal(db.files.size, 0, "nothing reached storage");
    assert.equal(member(db, ids.riya).photo_status, "none");
    assert.deepEqual(events(db, ids.riya), []);
});

test("the member's 'I agree' is recorded once, as a photo consent event from the desk", async () => {
    const db = fakePhotoDb();
    const summary = await agree(db, ids.riya);
    await agree(db, ids.riya);
    assert.equal(summary.consent, true);
    assert.deepEqual(events(db, ids.riya), [{ gym_id: gymA, member_id: ids.riya, channel: "photo", action: "granted", source: "desk", recorded_by: owner }]);
    await assert.rejects(photos.setPhotoConsent(ids.riya, gymA, { agree: true, source: "staff_form" }, db), (error) => error.status === 400);
});

test("withdrawing consent deletes the photo file and records a 'withdrawn' event", async () => {
    const db = fakePhotoDb();
    const path = await withPhoto(db, ids.riya);
    assert.ok(db.files.has(path));
    const summary = await photos.setPhotoConsent(ids.riya, gymA, { agree: false, source: "desk", recordedBy: owner }, db);
    assert.deepEqual([summary.status, summary.consent], ["none", false]);
    assert.equal(db.files.size, 0);
    assert.equal(member(db, ids.riya).photo_path, null);
    assert.deepEqual(events(db, ids.riya).map((event) => event.action), ["granted", "withdrawn"]);
    // If the file cannot be deleted, consent is not withdrawn yet, so state and file agree.
    const again = fakePhotoDb();
    await withPhoto(again, ids.riya);
    again.failRemove = true;
    await assert.rejects(photos.setPhotoConsent(ids.riya, gymA, { agree: false }, again), (error) => error.status === 503);
    assert.equal(member(again, ids.riya).photo_consent, true);
});

// ---------- Upload, replace, delete ----------

test("staff upload an approved photo into the member's own folder; replacing deletes the old file", async () => {
    const db = fakePhotoDb();
    const first = await withPhoto(db, ids.riya);
    assert.match(first, new RegExp(`^${gymA}/${ids.riya}/[A-Za-z0-9_-]{32}\\.jpg$`));
    assert.equal(member(db, ids.riya).photo_status, "approved");
    const stored = db.files.get(first);
    assert.equal(stored.contentType, "image/jpeg");
    assert.equal(stored.body.includes(Buffer.from("GPS")), false, "stored without location data");
    assert.ok(db.storageCalls.every((call) => call.bucket === PHOTO_BUCKET_NAME));

    await photos.uploadMemberPhoto(ids.riya, gymA, webpBytes(), db);
    const second = member(db, ids.riya).photo_path;
    assert.notEqual(second, first);
    assert.match(second, /\.webp$/);
    assert.deepEqual([...db.files.keys()], [second], "the old file is gone");
});

test("removing a photo deletes the file and keeps the member's consent", async () => {
    const db = fakePhotoDb();
    await withPhoto(db, ids.riya);
    const summary = await photos.deleteMemberPhoto(ids.riya, gymA, db);
    assert.deepEqual([summary.status, summary.consent], ["none", true]);
    assert.equal(db.files.size, 0);
});

test("archiving (deleting) a member deletes their photo file and clears the photo", async () => {
    const db = fakePhotoDb();
    await withPhoto(db, ids.riya);
    await deleteMember(ids.riya, gymA, db);
    const row = member(db, ids.riya);
    assert.ok(row.archived_at);
    assert.deepEqual([row.photo_path, row.photo_status], [null, "none"]);
    assert.equal(db.files.size, 0);
    // If storage cannot delete the file, the member is not archived and can be tried again.
    const failing = fakePhotoDb();
    await withPhoto(failing, ids.dev);
    failing.failRemove = true;
    await assert.rejects(deleteMember(ids.dev, gymA, failing), (error) => error.status === 503);
    assert.equal(member(failing, ids.dev).archived_at, null);
    assert.equal(failing.files.size, 1);
});

// ---------- Gym isolation and signed URLs ----------

test("one gym cannot upload, view, approve, reject or delete another gym's member photos", async () => {
    const db = fakePhotoDb();
    const path = await withPhoto(db, ids.aisha, gymB);
    for (const attempt of [
        photos.uploadMemberPhoto(ids.aisha, gymA, jpegBytes(), db),
        photos.deleteMemberPhoto(ids.aisha, gymA, db),
        photos.memberPhoto(ids.aisha, gymA, db),
        photos.setPhotoConsent(ids.aisha, gymA, { agree: false }, db),
        photos.rejectPendingPhoto(ids.aisha, gymA, owner, db),
        photos.approvePendingPhoto(ids.aisha, gymA, db)
    ]) {
        assert.equal(await status(attempt), 404);
    }
    assert.deepEqual(await photos.signedPhotoUrls([ids.aisha], gymA, { includePending: true }, db), {});
    assert.ok(db.files.has(path), "gym B's photo is untouched");
    assert.equal(member(db, ids.aisha).photo_consent, true);
});

test("signed URLs last about an hour and are made only for this gym's approved photos", async () => {
    const db = fakePhotoDb();
    await withPhoto(db, ids.riya);
    await withPhoto(db, ids.aisha, gymB);
    await agree(db, ids.neha);
    Object.assign(member(db, ids.neha), { photo_path: `${gymA}/${ids.neha}/pendingPhotoAAAAAAAAAAAAAA.jpg`, photo_status: "pending", photo_updated_at: morning.toISOString() });
    db.files.set(member(db, ids.neha).photo_path, { body: jpegBytes() });

    const urls = await photos.signedPhotoUrls([ids.riya, ids.neha, ids.aisha, ids.dev], gymA, {}, db);
    assert.deepEqual(Object.keys(urls), [ids.riya]);
    assert.match(urls[ids.riya].url, /\/object\/sign\/member-photos\//);
    const signed = db.storageCalls.filter((call) => call.action === "sign");
    assert.ok(signed.every((call) => call.seconds === 3600));
    assert.ok(signed.every((call) => call.paths.every((path) => path.startsWith(`${gymA}/`))), "only gym A's paths were signed");
    const review = await photos.signedPhotoUrls([ids.riya, ids.neha], gymA, { includePending: true }, db);
    assert.deepEqual(Object.keys(review).sort(), [ids.riya, ids.neha].sort());
    // Check-in cards get approved photos only.
    assert.ok((await photos.withCheckinPhoto({ member: { id: ids.riya } }, gymA, db)).member.photo_url);
    assert.equal((await photos.withCheckinPhoto({ member: { id: ids.neha } }, gymA, db)).member.photo_url, null);
    assert.equal((await photos.withCheckinPhoto({ member: { id: ids.aisha } }, gymA, db)).member.photo_url, null);
});

// ---------- Entrance poster page ----------

async function startEntrance(db) {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use("/c", createEntranceRouter({ client: db, minLinkMs: 0, minPhotoMs: 0, now: () => morning }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = db.tables.gyms.find((gym) => gym.id === gymA).entrance_token;
    const send = (secret, body = jpegBytes(), { consent = true, ip = "203.0.113.20" } = {}) => fetch(`${base}/c/${token}/photo`, {
        method: "POST",
        headers: {
            "Content-Type": "image/jpeg",
            Origin: base,
            "X-Forwarded-For": ip,
            ...(consent ? { "X-Photo-Consent": "agreed" } : {}),
            ...(secret ? { Cookie: `${DEVICE_COOKIE}=${secret}` } : {})
        },
        body
    }).then(async (response) => ({ status: response.status, json: await response.json() }));
    return { send, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function waitingPhone(db, phone) {
    const secret = newDeviceSecret();
    await requestLink(db.tables.gyms.find((gym) => gym.id === gymA), secret, phone, { now: morning }, db);
    return secret;
}

test("a member's own photo from the poster page is saved only as pending, with poster-page consent", async () => {
    const db = posterDb();
    const { send, close } = await startEntrance(db);
    try {
        const secret = await waitingPhone(db, "9876543210");
        const reply = await send(secret, jpegBytes(), { ip: "203.0.113.21" });
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.json.data, { state: "photo_sent" });
        const riya = member(db, ids.riya);
        assert.equal(riya.photo_status, "pending");
        assert.equal(riya.photo_device_id, db.tables.member_devices.find((row) => row.device_secret_hash === hashDeviceSecret(secret)).id);
        assert.deepEqual(events(db, ids.riya).map((event) => [event.action, event.source]), [["granted", "poster_page"]]);
        // A pending photo is not shown on check-in cards.
        assert.equal((await photos.withCheckinPhoto({ member: { id: ids.riya } }, gymA, db)).member.photo_url, null);
        // Sending again cannot replace the pending photo.
        const before = riya.photo_path;
        assert.equal((await send(secret, jpegBytes(), { ip: "203.0.113.21" })).status, 200);
        assert.equal(member(db, ids.riya).photo_path, before);
        assert.equal(db.files.size, 1);
    } finally {
        await close();
    }
});

test("the poster page answers the same and saves nothing for unknown numbers, family phones or members with a photo", async () => {
    const db = posterDb({ [ids.dev]: {} });
    const { send, close } = await startEntrance(db);
    try {
        const path = await withPhoto(db, ids.dev);
        const cases = {
            stranger: await waitingPhone(db, "9000000001"),
            family: await waitingPhone(db, "9123403210"),
            hasPhoto: await waitingPhone(db, "9876543211"),
            noCookie: ""
        };
        let ip = 30;
        for (const [name, secret] of Object.entries(cases)) {
            const reply = await send(secret, jpegBytes(), { ip: `203.0.113.${ip += 1}` });
            assert.equal(reply.status, 200, name);
            assert.deepEqual(reply.json.data, { state: "photo_sent" }, name);
        }
        assert.deepEqual([...db.files.keys()], [path], "only Dev's desk photo exists");
        assert.equal(member(db, ids.dev).photo_status, "approved", "an approved photo cannot be replaced from the poster page");
        assert.equal(member(db, ids.kabir).photo_status, "none");
        assert.equal(member(db, ids.meera).photo_status, "none");
        assert.deepEqual(events(db, ids.kabir), []);
    } finally {
        await close();
    }
});

test("the poster page checks the file and the agreement first, and limits uploads per phone", async () => {
    const db = posterDb();
    const { send, close } = await startEntrance(db);
    try {
        const secret = await waitingPhone(db, "9876543213");
        assert.equal((await send(secret, PNG, { ip: "203.0.113.50" })).status, 400);
        assert.equal((await send(secret, jpegBytes(), { consent: false, ip: "203.0.113.50" })).status, 400);
        assert.equal((await send(secret, jpegBytes({ padTo: MAX_PHOTO_BYTES }), { ip: "203.0.113.50" })).status, 413);
        assert.equal(db.files.size, 0);
        // Three uploads per phone per hour.
        assert.equal((await send(secret, jpegBytes(), { ip: "203.0.113.51" })).status, 429);
    } finally {
        await close();
    }
});

test("staff approve or reject a pending photo; rejecting deletes it and asks again at the desk", async () => {
    const db = posterDb();
    const { send, close } = await startEntrance(db);
    try {
        const secretRiya = await waitingPhone(db, "9876543210");
        const secretNeha = await waitingPhone(db, "9876543213");
        await send(secretRiya, jpegBytes(), { ip: "203.0.113.60" });
        await send(secretNeha, jpegBytes(), { ip: "203.0.113.61" });
        const pending = await photos.listPendingPhotos(gymA, db);
        assert.deepEqual(pending.map((row) => row.member_id).sort(), [ids.riya, ids.neha].sort());
        assert.ok(pending.every((row) => row.url && row.device_id));
        assert.deepEqual(await photos.listPendingPhotos(gymB, db), [], "gym B sees none of them");

        const approved = await photos.approvePendingPhoto(ids.riya, gymA, db);
        assert.equal(approved.status, "approved");
        assert.equal(member(db, ids.riya).photo_device_id, null);

        const nehaPath = member(db, ids.neha).photo_path;
        const rejected = await photos.rejectPendingPhoto(ids.neha, gymA, owner, db);
        assert.deepEqual([rejected.status, rejected.consent], ["none", false]);
        assert.equal(db.files.has(nehaPath), false, "the rejected file is deleted");
        assert.deepEqual(events(db, ids.neha).map((event) => [event.action, event.source]), [["granted", "poster_page"], ["withdrawn", "desk"]]);
        assert.equal(await status(photos.rejectPendingPhoto(ids.riya, gymA, owner, db)), 404, "an approved photo is not 'pending'");
    } finally {
        await close();
    }
});

test("rejecting a phone request also deletes the photo that phone sent", async () => {
    const db = posterDb();
    const { send, close } = await startEntrance(db);
    try {
        const secret = await waitingPhone(db, "9876543210");
        await send(secret, jpegBytes(), { ip: "203.0.113.70" });
        const device = db.tables.member_devices.find((row) => row.device_secret_hash === hashDeviceSecret(secret));
        assert.equal(await photos.rejectPhotosFromDevice(device.id, gymA, owner, db), 1);
        assert.equal(member(db, ids.riya).photo_status, "none");
        assert.equal(db.files.size, 0);
    } finally {
        await close();
    }
});

// ---------- Photos stay inside the app ----------

test("photos never appear in the welcome card, member card, receipts, WhatsApp messages or the poster's answer", async () => {
    const shared = [
        "../../assets/js/modules/welcome.js", // welcome card and member QR card images
        "../../assets/js/modules/welcomeUi.js",
        "../../assets/js/modules/cardCanvas.js",
        "../../assets/js/welcomeMessage.js",
        "../../assets/js/modules/upiPayments.js", // payment QR and receipt images
        "../../assets/js/modules/expiryReminder.js", // WhatsApp expiry reminders
        "../../assets/js/reminderMessage.js",
        "../services/paymentsService.js",
        "../services/whatsappMessagesService.js",
        "../routes/whatsapp.js"
    ];
    for (const file of shared) {
        assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /photo/i, file);
    }
    // Member lists and profiles carry the photo state only, never the storage path.
    const membersSource = readFileSync(new URL("../services/membersService.js", import.meta.url), "utf8");
    const columns = membersSource.slice(membersSource.indexOf("const memberColumns"), membersSource.indexOf('].join(",")'));
    assert.doesNotMatch(columns, /photo_path|photo_device_id/);

    // The poster's check-in answer on the member's phone has no photo in it.
    const db = posterDb();
    await withPhoto(db, ids.riya);
    const secret = newDeviceSecret();
    const gym = db.tables.gyms.find((row) => row.id === gymA);
    await requestLink(gym, secret, "9876543210", { now: morning }, db);
    await approveDevice(db.tables.member_devices[0].id, gymA, owner, db, morning);
    const answer = await entranceCheckIn(gym, secret, { now: morning }, db);
    assert.equal(answer.result, "checked_in");
    assert.doesNotMatch(JSON.stringify(answer), /photo|storage|sign/i);
});
