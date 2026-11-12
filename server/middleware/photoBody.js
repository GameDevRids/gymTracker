import express from "express";
import { MAX_PHOTO_BYTES } from "../services/photoFile.js";

// Reads an uploaded photo as raw bytes, whatever Content-Type the browser claimed: the file is
// checked by its content (services/photoFile.js), never by its name or declared type.
const readRaw = express.raw({ type: () => true, limit: MAX_PHOTO_BYTES });

export function photoBody(request, response, next) {
    readRaw(request, response, (error) => {
        if (error?.type === "entity.too.large" || error?.status === 413) {
            return response.status(413).json({ status: "error", message: "The photo must be 300 KB or smaller." });
        }
        if (error) return response.status(400).json({ status: "error", message: "The photo could not be read." });
        if (!Buffer.isBuffer(request.body) || !request.body.length) {
            return response.status(400).json({ status: "error", message: "Choose a photo to upload." });
        }
        next();
    });
}
