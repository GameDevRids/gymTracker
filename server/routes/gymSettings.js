import express from "express";
import { fillUnsetPreferences, getGymSettings, saveGymSettings } from "../services/gymSettingsService.js";
import { validateGymSettings, validateLocalDataImport } from "../middleware/validateGymSettings.js";
import { importExpiryReminders, saveTemplateIfUnset } from "../services/whatsappMessagesService.js";
import { membersErrorHandler } from "../controllers/membersController.js";
import { getCheckinSettings, replaceEntranceToken, saveCheckinSettings } from "../services/checkinSettingsService.js";
import { validateCheckinSettings } from "../middleware/validateCheckin.js";
import { ownerOnly, requireOwner } from "../middleware/requireOwner.js";
import { getRenewalSettings, saveRenewalSettings } from "../services/renewalSettingsService.js";
import { validateRenewalSettings } from "../middleware/validateRenewal.js";

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

// "Move my saved data to the cloud": settings, the reminder message and "Reminded" marks an
// older version kept in one browser. Fills only what the gym has not saved yet; safe to repeat.
router.post("/import-local", validateLocalDataImport, async (request, response, next) => {
    try {
        const { preferences, expiryReminderTemplate, expiryReminders } = request.localData;
        const userId = request.authUser?.id || null;
        const filled = await fillUnsetPreferences(request.gymId, preferences, userId);
        const templateSaved = expiryReminderTemplate
            ? await saveTemplateIfUnset("expiry_reminder", expiryReminderTemplate.language, expiryReminderTemplate.body, userId, request.gymId)
            : false;
        const reminders = await importExpiryReminders(expiryReminders, userId, request.gymId);
        response.json({ status: "success", data: { preferences_filled: filled, reminder_message_saved: templateSaved, reminders } });
    } catch (error) {
        next(error);
    }
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

// Settings > Renewals and grace (migration 020). Every login reads them (the Renew sheet uses
// the welcome-back discount); only the owner changes them.
router.get("/renewals", (request, response, next) => {
    getRenewalSettings(request.gymId, request.gymRole)
        .then((settings) => response.json({ status: "success", data: settings }))
        .catch(next);
});

router.put("/renewals", ownerOnly("Only the gym owner can change the renewal settings."), validateRenewalSettings, (request, response, next) => {
    saveRenewalSettings(request.gymId, request.renewalSettings, request.gymRole)
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
