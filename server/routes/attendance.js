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
import { validateCheckinSearch } from "../middleware/validateCheckin.js";
import { withCheckinPhoto } from "../services/memberPhotosService.js";

const router = express.Router();
const scanRateLimit = createScanRateLimit();

// Staff result cards show the member's approved photo so staff can confirm it is them.
router.post("/scan", scanRateLimit, validateScan, (request, response, next) => {
    attendance.scanCheckIn(request.scanToken, request.gymId, request.authUser?.id || null)
        .then((result) => withCheckinPhoto(result, request.gymId))
        .then((result) => response.json({ status: "success", data: result }))
        .catch(next);
});

router.post("/manual", validateManualCheckIn, (request, response, next) => {
    attendance.manualCheckIn(request.checkInMemberId, request.gymId, request.authUser?.id || null)
        .then((result) => withCheckinPhoto(result, request.gymId))
        .then((result) => response.json({ status: "success", data: result }))
        .catch(next);
});

router.post("/import", validateAttendanceImport, (request, response, next) => {
    attendance.importAttendance(request.importRecords, request.gymId, request.authUser?.id || null)
        .then((result) => response.json({ status: "success", data: result }))
        .catch(next);
});

// "Can't scan? Check in manually": last 4 digits of the phone, or part of the name.
router.get("/search", validateCheckinSearch, (request, response, next) => {
    attendance.searchCheckInMembers(request.checkinSearch, request.gymId)
        .then((rows) => response.json({ status: "success", data: rows }))
        .catch(next);
});

router.get("/", validateAttendanceQuery, (request, response, next) => {
    attendance.listAttendance(request.attendanceQuery, request.gymId)
        .then((rows) => response.json({ status: "success", data: rows }))
        .catch(next);
});

router.use(membersErrorHandler);

export default router;
