import express from "express";
import { getGymSettings, saveGymSettings } from "../services/gymSettingsService.js";
import { validateGymSettings } from "../middleware/validateGymSettings.js";
import { membersErrorHandler } from "../controllers/membersController.js";
import { getCheckinSettings, replaceEntranceToken, saveCheckinSettings } from "../services/checkinSettingsService.js";
import { validateCheckinSettings } from "../middleware/validateCheckin.js";
import { requireOwner } from "../middleware/requireOwner.js";

const router = express.Router();

router.get("/", (request, response, next) => {
    getGymSettings(request.gymId)
        .then((settings) => response.json({ status: "success", data: settings }))
        .catch(next);
});

router.put("/", validateGymSettings, (request, response, next) => {
    saveGymSettings(request.gymId, request.validatedSettings, request.authUser?.id || null)
        .then((settings) => response.json({ status: "success", data: settings }))
        .catch(next);
});

// Settings > Attendance. Every login can read them; only the owner can change them.
router.get("/attendance", (request, response, next) => {
    getCheckinSettings(request.gymId, request.gymRole)
        .then((settings) => response.json({ status: "success", data: settings }))
        .catch(next);
});

router.put("/attendance", requireOwner, validateCheckinSettings, (request, response, next) => {
    saveCheckinSettings(request.gymId, request.checkinSettings, request.gymRole)
        .then((settings) => response.json({ status: "success", data: settings }))
        .catch(next);
});

// A new poster link: printed posters with the old QR stop working at once.
router.post("/attendance/replace-poster", requireOwner, (request, response, next) => {
    replaceEntranceToken(request.gymId, request.gymRole)
        .then((settings) => response.json({ status: "success", data: settings }))
        .catch(next);
});

router.use(membersErrorHandler);

export default router;
