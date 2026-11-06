import express from "express";
import {
    getExpiringMemberships,
    getMembership,
    getMemberships,
    membershipsErrorHandler
} from "../controllers/membershipsController.js";
import { validateExpiringMembershipQuery, validateMembershipId, validateMembershipListQuery } from "../middleware/validateMembership.js";

const router = express.Router();

router.get("/expiring", validateExpiringMembershipQuery, getExpiringMemberships);
router.get("/", validateMembershipListQuery, getMemberships);
router.get("/:id", validateMembershipId, getMembership);
router.use(membershipsErrorHandler);

export default router;
