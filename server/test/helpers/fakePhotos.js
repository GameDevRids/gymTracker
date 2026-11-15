// Adds what the member-photo code needs to the in-memory check-in fake: photo columns on every
// member, a consent-event table, the photo-consent database function (same rules as migration
// 014) and a Supabase Storage stand-in that records every file and signed URL.
import { fakeCheckinDb } from "./fakeCheckinDb.js";

export const PHOTO_BUCKET_NAME = "member-photos";

/** A small but well-formed JPEG: SOI, APP0, optional APP1 (EXIF with "GPS"), SOF0, SOS, EOI. */
export function jpegBytes({ width = 512, height = 512, exif = true, padTo = 0 } = {}) {
    const segment = (marker, data) => {
        const header = Buffer.from([0xff, marker, 0, 0]);
        header.writeUInt16BE(data.length + 2, 2);
        return Buffer.concat([header, data]);
    };
    const sof = Buffer.alloc(15);
    sof[0] = 8;
    sof.writeUInt16BE(height, 1);
    sof.writeUInt16BE(width, 3);
    sof[5] = 3;
    const parts = [
        Buffer.from([0xff, 0xd8]),
        segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
        ...(exif ? [segment(0xe1, Buffer.from("Exif\0\0GPSLatitude 18.52 GPSLongitude 73.85", "latin1"))] : []),
        segment(0xfe, Buffer.from("comment: taken at home", "latin1")),
        segment(0xc0, sof),
        segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
        Buffer.alloc(Math.max(64, padTo), 0x55),
        Buffer.from([0xff, 0xd9])
    ];
    return Buffer.concat(parts);
}

/** A small WebP (VP8X + VP8 + EXIF + XMP chunks). */
export function webpBytes({ width = 400, height = 300 } = {}) {
    const chunk = (fourcc, data) => {
        const header = Buffer.alloc(8);
        header.write(fourcc, 0, "latin1");
        header.writeUInt32LE(data.length, 4);
        return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x08 | 0x04;
    vp8x.writeUIntLE(width - 1, 4, 3);
    vp8x.writeUIntLE(height - 1, 7, 3);
    const vp8 = Buffer.alloc(30);
    vp8[3] = 0x9d; vp8[4] = 0x01; vp8[5] = 0x2a;
    vp8.writeUInt16LE(width, 6);
    vp8.writeUInt16LE(height, 8);
    const body = Buffer.concat([chunk("VP8X", vp8x), chunk("VP8 ", vp8), chunk("EXIF", Buffer.from("GPS 18.52,73.85", "latin1")), chunk("XMP ", Buffer.from("<x:xmpmeta/>", "latin1"))]);
    const header = Buffer.alloc(12);
    header.write("RIFF", 0, "latin1");
    header.writeUInt32LE(body.length + 4, 4);
    header.write("WEBP", 8, "latin1");
    return Buffer.concat([header, body]);
}

export function fakePhotoDb(options = {}) {
    const db = fakeCheckinDb(options);
    for (const member of db.tables.members) {
        Object.assign(member, { photo_path: null, photo_status: "none", photo_updated_at: null, photo_consent: false, photo_consent_at: null, photo_device_id: null }, options.photo?.[member.id] || {});
    }
    db.tables.member_consent_events = [];
    const files = new Map();
    const storageCalls = [];
    db.files = files;
    db.storageCalls = storageCalls;
    db.failRemove = false;

    db.rpc = async (name, args) => {
        if (name !== "gympulse_set_member_photo_consent") return { data: null, error: { code: "PGRST202" } };
        const member = db.tables.members.find((row) => row.id === args.p_member_id && row.gym_id === args.p_gym_id && !row.archived_at);
        if (!member) return { data: null, error: { code: "P0002" } };
        if (!["desk", "poster_page"].includes(args.p_source)) return { data: null, error: { code: "22023" } };
        if (member.photo_consent !== args.p_consent) {
            member.photo_consent = args.p_consent;
            member.photo_consent_at = args.p_consent ? new Date().toISOString() : null;
            if (!args.p_consent) Object.assign(member, { photo_path: null, photo_status: "none", photo_device_id: null, photo_updated_at: new Date().toISOString() });
            db.tables.member_consent_events.push({ gym_id: member.gym_id, member_id: member.id, channel: "photo", action: args.p_consent ? "granted" : "withdrawn", source: args.p_source, recorded_by: args.p_recorded_by });
        }
        return { data: [{ ...member }], error: null };
    };

    db.storage = {
        from(bucket) {
            return {
                async upload(path, body, uploadOptions) {
                    storageCalls.push({ bucket, action: "upload", path, uploadOptions });
                    if (files.has(path)) return { data: null, error: { message: "exists" } };
                    files.set(path, { body: Buffer.from(body), contentType: uploadOptions?.contentType });
                    return { data: { path }, error: null };
                },
                async remove(paths) {
                    storageCalls.push({ bucket, action: "remove", paths });
                    if (db.failRemove) return { data: null, error: { message: "storage down" } };
                    paths.forEach((path) => files.delete(path));
                    return { data: paths.map((name) => ({ name })), error: null };
                },
                async createSignedUrls(paths, seconds) {
                    storageCalls.push({ bucket, action: "sign", paths, seconds });
                    return { data: paths.map((path) => ({ path, signedUrl: files.has(path) ? `https://project.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=t` : null, error: files.has(path) ? null : "not found" })), error: null };
                }
            };
        }
    };
    return db;
}
