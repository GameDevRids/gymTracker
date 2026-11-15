import express from "express";
import { getGymSummary } from "../services/summaryService.js";
import { membersErrorHandler } from "../controllers/membersController.js";

const router = express.Router();

// GET /api/summary?months=6 — gym-wide totals for the Overview, Analytics and Payments pages.
router.get("/", (request, response, next) => {
    const months = request.query.months === undefined ? 6 : Number(request.query.months);
    if (!Number.isInteger(months) || months < 1 || months > 24) {
        return response.status(400).json({ status: "error", message: "months must be a whole number from 1 to 24." });
    }
    getGymSummary(request.gymId, { months })
        .then((summary) => {
            response.set("Cache-Control", "no-store");
            response.json({ status: "success", data: summary });
        })
        .catch(next);
});

router.use(membersErrorHandler);

export default router;
