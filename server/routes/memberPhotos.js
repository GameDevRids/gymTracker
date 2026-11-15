import express from "express";
import { z } from "zod";
import { membersErrorHandler } from "../controllers/membersController.js";
import { listPendingPhotos, signedPhotoUrls } from "../services/memberPhotosService.js";

// Gym-wide photo lists for the app (any login of the gym). Per-member photo routes live in
// routes/members.js. Every answer is limited to the caller's own gym (request.gymId).
const router = express.Router();
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const urlsSchema = z.object({ ids: z.array(uuid).min(1).max(100) }).strict();

// Photos members sent from the entrance poster page, waiting for approval.
router.get("/", (request, response, next) => {
    if (request.query.status !== "pending") {
        return response.status(400).json({ status: "error", message: "Only ?status=pending is supported." });
    }
    listPendingPhotos(request.gymId)
        .then((rows) => response.json({ status: "success", data: rows }))
        .catch(next);
});

// Signed URLs (about 1 hour) for approved photos of up to 100 members, for lists.
router.post("/urls", (request, response, next) => {
    const parsed = urlsSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ status: "error", message: "Send ids as a list of 1 to 100 member IDs." });
    signedPhotoUrls(parsed.data.ids, request.gymId)
        .then((urls) => {
            response.set("Cache-Control", "no-store");
            response.json({ status: "success", data: urls });
        })
        .catch(next);
});

router.use(membersErrorHandler);

export default router;
