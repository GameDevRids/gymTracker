import express from "express";
import { ownerOnly } from "../middleware/requireOwner.js";

// TEMPORARY: lets the owner check that server errors reach Sentry. Remove after the test.
// Mounted behind requireAuth(); ownerOnly refuses everyone but the gym owner.
const router = express.Router();

router.get("/", ownerOnly("Only the gym owner can run the Sentry test."), () => {
    throw new Error("GymPulse Sentry server test");
});

export default router;
