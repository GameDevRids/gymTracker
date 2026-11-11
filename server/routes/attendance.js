import express from "express";
import * as attendance from "../services/attendanceService.js";
import { membersErrorHandler } from "../controllers/membersController.js";
import {
    createScanRateLimit,
    validateAttendanceImport,
    validateAttendanceQuery,
    validateManualCheckIn,
    validateScan
} from "../middleware/validateAttendance.js";

const router = express.Router();
const scanRateLimit = createScanRateLimit();

router.post("/scan", scanRateLimit, validateScan, (request, response, next) => {
    attendance.scanCheckIn(request.scanToken, request.gymId, request.authUser?.id || null)
        .then((result) => response.json({ status: "success", data: result }))
        .catch(next);
});

router.post("/manual", validateManualCheckIn, (request, response, next) => {
    attendance.manualCheckIn(request.checkInMemberId, request.gymId, request.authUser?.id || null)
        .then((result) => response.json({ status: "success", data: result }))
        .catch(next);
});

router.post("/import", validateAttendanceImport, (request, response, next) => {
    attendance.importAttendance(request.importRecords, request.gymId, request.authUser?.id || null)
        .then((result) => response.json({ status: "success", data: result }))
        .catch(next);
});

router.get("/", validateAttendanceQuery, (request, response, next) => {
    attendance.listAttendance(request.attendanceQuery, request.gymId)
        .then((rows) => response.json({ status: "success", data: rows }))
        .catch(next);
});

router.use(membersErrorHandler);

export default router;
