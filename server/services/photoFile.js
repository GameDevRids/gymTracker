// Checks an uploaded member photo by its bytes, never by its name or the Content-Type the
// browser sent, and removes metadata (EXIF, XMP, comments, which can hold GPS location) before
// it is stored. No image library: JPEG segments and WebP RIFF chunks are walked directly.

export const MAX_PHOTO_BYTES = 300 * 1024;
export const MAX_PHOTO_SIDE = 1024;

export class PhotoFileError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const NOT_AN_IMAGE = "Upload a JPEG or WebP photo.";

// ---------- JPEG ----------

// Start-of-frame markers carry the image size (C4 DHT, C8 JPG and CC DAC are not frames).
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
// Segments kept: APP0 (JFIF), APP14 (Adobe colour transform) and APP2 only when it is an ICC
// colour profile. Every other APPn segment (EXIF, XMP, maker notes) and comments are dropped.
function keepJpegSegment(marker, data) {
    if (marker < 0xe0 || marker > 0xef) return marker !== 0xfe;
    if (marker === 0xe0 || marker === 0xee) return true;
    return marker === 0xe2 && data.subarray(0, 12).toString("latin1") === "ICC_PROFILE\0";
}

function cleanJpeg(buffer) {
    const parts = [buffer.subarray(0, 2)];
    let offset = 2;
    let size = null;
    while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) throw new PhotoFileError(NOT_AN_IMAGE);
        let marker = buffer[offset + 1];
        // Fill bytes (FF FF …) may pad between segments.
        while (marker === 0xff && offset + 2 < buffer.length) {
            offset += 1;
            marker = buffer[offset + 1];
        }
        if (marker === undefined) throw new PhotoFileError(NOT_AN_IMAGE);
        if (marker === 0xd9) {
            parts.push(buffer.subarray(offset, offset + 2));
            break;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            parts.push(buffer.subarray(offset, offset + 2));
            offset += 2;
            continue;
        }
        if (offset + 4 > buffer.length) throw new PhotoFileError(NOT_AN_IMAGE);
        const length = buffer.readUInt16BE(offset + 2);
        const end = offset + 2 + length;
        if (length < 2 || end > buffer.length) throw new PhotoFileError(NOT_AN_IMAGE);
        const data = buffer.subarray(offset + 4, end);
        if (SOF_MARKERS.has(marker)) {
            if (data.length < 5) throw new PhotoFileError(NOT_AN_IMAGE);
            size = { height: data.readUInt16BE(1), width: data.readUInt16BE(3) };
        }
        if (marker === 0xda) {
            // Start of scan: the compressed image follows to the end of the file, kept as is.
            if (!size) throw new PhotoFileError(NOT_AN_IMAGE);
            parts.push(buffer.subarray(offset));
            return { buffer: Buffer.concat(parts), ...size };
        }
        if (keepJpegSegment(marker, data)) parts.push(buffer.subarray(offset, end));
        offset = end;
    }
    throw new PhotoFileError(NOT_AN_IMAGE);
}

// ---------- WebP ----------

const WEBP_DROP = new Set(["EXIF", "XMP "]);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIMATION = 0x02;

function webpSize(fourcc, data) {
    if (fourcc === "VP8X" && data.length >= 10) {
        return { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1 };
    }
    if (fourcc === "VP8 " && data.length >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
        return { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
    }
    if (fourcc === "VP8L" && data.length >= 5 && data[0] === 0x2f) {
        const bits = data.readUInt32LE(1);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
}

function cleanWebp(buffer) {
    if (buffer.length < 20) throw new PhotoFileError(NOT_AN_IMAGE);
    const declared = buffer.readUInt32LE(4) + 8;
    if (declared > buffer.length || declared < 20) throw new PhotoFileError(NOT_AN_IMAGE);
    const chunks = [];
    let offset = 12;
    let size = null;
    let hasImage = false;
    while (offset + 8 <= declared) {
        const fourcc = buffer.subarray(offset, offset + 4).toString("latin1");
        const length = buffer.readUInt32LE(offset + 4);
        const end = offset + 8 + length + (length % 2);
        if (offset + 8 + length > declared) throw new PhotoFileError(NOT_AN_IMAGE);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (fourcc === "ANIM" || fourcc === "ANMF") throw new PhotoFileError("Animated images cannot be used as a photo.");
        if (fourcc === "VP8 " || fourcc === "VP8L") hasImage = true;
        if (!size || fourcc === "VP8X") size = webpSize(fourcc, data) || size;
        if (!WEBP_DROP.has(fourcc)) {
            let chunk = Buffer.from(buffer.subarray(offset, Math.min(end, declared)));
            if (fourcc === "VP8X") {
                if (chunk[8] & VP8X_ANIMATION) throw new PhotoFileError("Animated images cannot be used as a photo.");
                chunk[8] &= ~(VP8X_EXIF | VP8X_XMP);
            }
            if (chunk.length % 2) chunk = Buffer.concat([chunk, Buffer.alloc(1)]);
            chunks.push(chunk);
        }
        offset = end;
    }
    if (!hasImage || !size) throw new PhotoFileError(NOT_AN_IMAGE);
    const body = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.write("RIFF", 0, "latin1");
    header.writeUInt32LE(body.length + 4, 4);
    header.write("WEBP", 8, "latin1");
    return { buffer: Buffer.concat([header, body]), ...size };
}

// ---------- Entry point ----------

export function photoType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
    if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
    return null;
}

/**
 * Returns the photo with metadata removed, its type, file extension and Content-Type.
 * Throws PhotoFileError for anything that is not a JPEG or WebP image of a sensible size.
 */
export function preparePhoto(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new PhotoFileError("Choose a photo to upload.");
    if (buffer.length > MAX_PHOTO_BYTES) throw new PhotoFileError("The photo must be 300 KB or smaller.", 413);
    const type = photoType(buffer);
    if (!type) throw new PhotoFileError(NOT_AN_IMAGE);
    const cleaned = type === "jpeg" ? cleanJpeg(buffer) : cleanWebp(buffer);
    if (!cleaned.width || !cleaned.height) throw new PhotoFileError(NOT_AN_IMAGE);
    if (cleaned.width > MAX_PHOTO_SIDE || cleaned.height > MAX_PHOTO_SIDE) {
        throw new PhotoFileError(`The photo must be at most ${MAX_PHOTO_SIDE}×${MAX_PHOTO_SIDE} pixels.`);
    }
    return {
        buffer: cleaned.buffer,
        width: cleaned.width,
        height: cleaned.height,
        type,
        extension: type === "jpeg" ? "jpg" : "webp",
        contentType: type === "jpeg" ? "image/jpeg" : "image/webp"
    };
}
