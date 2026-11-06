import express from "express";
import {
    getMembership,
    getMemberships,
    membershipsErrorHandler
} from "../controllers/membershipsController.js";
import { validateMembershipId, validateMembershipListQuery } from "../middleware/validateMembership.js";

const router = express.Router();

router.get("/", validateMembershipListQuery, getMemberships);
router.get("/:id", validateMembershipId, getMembership);
router.use(membershipsErrorHandler);

export default router;
