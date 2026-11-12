import express from "express";
import { approveDevice, listPendingDevices, rejectDevice, revokeDevice } from "../services/entranceService.js";
import { validateDeviceId } from "../middleware/validateCheckin.js";
import { membersErrorHandler } from "../controllers/membersController.js";

// Front desk: phones waiting for approval, and revoking a linked phone. Any login of the gym.
const router = express.Router();

router.get("/", (request, response, next) => {
    if (request.query.status !== undefined && request.query.status !== "pending") {
        return response.status(400).json({ status: "error", message: "Only ?status=pending is supported." });
    }
    listPendingDevices(request.gymId)
        .then((rows) => response.json({ status: "success", data: rows }))
        .catch(next);
});

router.post("/:id/approve", validateDeviceId, (request, response, next) => {
    approveDevice(request.params.id, request.gymId, request.authUser?.id || null)
        .then((row) => response.json({ status: "success", data: row }))
        .catch(next);
});

router.post("/:id/reject", validateDeviceId, (request, response, next) => {
    rejectDevice(request.params.id, request.gymId)
        .then((row) => response.json({ status: "success", data: row }))
        .catch(next);
});

router.post("/:id/revoke", validateDeviceId, (request, response, next) => {
    revokeDevice(request.params.id, request.gymId, request.authUser?.id || null)
        .then((row) => response.json({ status: "success", data: row }))
        .catch(next);
});

router.use(membersErrorHandler);

export default router;
