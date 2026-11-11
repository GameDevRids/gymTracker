import express from "express";
import { getGymSettings, saveGymSettings } from "../services/gymSettingsService.js";
import { validateGymSettings } from "../middleware/validateGymSettings.js";
import { membersErrorHandler } from "../controllers/membersController.js";

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

router.use(membersErrorHandler);

export default router;
