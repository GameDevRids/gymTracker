import express from "express";
import { z } from "zod";
import { ownerOnly } from "../middleware/requireOwner.js";
import { createLimit } from "../middleware/authRateLimit.js";
import * as accountService from "../services/accountService.js";
import { logger } from "../config/logger.js";

// /api/account — mounted with requireAuth({ allowPendingDeletion: true }), so a gym waiting to be
// erased can still read its status and the owner can cancel.

const termsSchema = z.object({ version: z.string().max(20) }).strict();
const deleteSchema = z.object({ confirm_name: z.string().max(200), password: z.string().min(1).max(512) }).strict();

function invalid(response, message) {
    return response.status(400).json({ status: "error", message });
}

export function createAccountRouter(service = accountService) {
    const router = express.Router();
    const deleteLimit = createLimit(10, "Too many attempts. Please wait 15 minutes and try again.");

    router.get("/status", async (request, response, next) => {
        try {
            const data = await service.getAccountStatus({ userId: request.authUser.id, gymId: request.gymId });
            response.json({ status: "success", data });
        } catch (error) {
            next(error);
        }
    });

    router.post("/terms", async (request, response, next) => {
        const parsed = termsSchema.safeParse(request.body);
        if (!parsed.success) return invalid(response, "Agree to the Terms to continue.");
        try {
            response.json({ status: "success", data: await service.acceptTerms(request.authUser.id, parsed.data.version) });
        } catch (error) {
            next(error);
        }
    });

    router.post("/delete-gym", deleteLimit, ownerOnly("Only the gym owner can delete the gym."), async (request, response, next) => {
        const parsed = deleteSchema.safeParse(request.body);
        if (!parsed.success) return invalid(response, "Type the gym's name and your password to confirm.");
        if (!request.gymId) return response.status(403).json({ status: "error", message: "Create a gym to continue." });
        try {
            const deletion = await service.requestGymDeletion({
                gymId: request.gymId,
                gymName: request.gym?.name,
                userId: request.authUser.id,
                email: request.authUser.email,
                confirmName: parsed.data.confirm_name,
                password: parsed.data.password
            });
            response.json({ status: "success", data: { deletion } });
        } catch (error) {
            next(error);
        }
    });

    router.post("/cancel-deletion", ownerOnly("Only the gym owner can cancel the deletion."), async (request, response, next) => {
        try {
            await service.cancelGymDeletion(request.gymId);
            response.json({ status: "success", message: "The deletion was cancelled. Your gym works as before." });
        } catch (error) {
            next(error);
        }
    });

    router.use((error, _request, response, next) => {
        // Errors without a status are unexpected: the app's 500 handler logs and reports them.
        if (!Number.isInteger(error?.status)) return next(error);
        if (error.status === 500) logger.error({ err: error }, "Account request failed.");
        response.status(error.status).json({ status: "error", message: error.message });
    });
    return router;
}

export default createAccountRouter();
