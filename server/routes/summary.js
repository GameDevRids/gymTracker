import express from "express";
import { getGymSummary } from "../services/summaryService.js";
import { countStatuses, memberStatuses } from "../services/memberStatusService.js";
import { membersErrorHandler } from "../controllers/membersController.js";

const router = express.Router();

// GET /api/summary?months=6 — gym-wide totals for the Overview, Analytics and Payments pages.
router.get("/", (request, response, next) => {
    const months = request.query.months === undefined ? 6 : Number(request.query.months);
    if (!Number.isInteger(months) || months < 1 || months > 24) {
        return response.status(400).json({ status: "error", message: "months must be a whole number from 1 to 24." });
    }
    // The status counts never hold up the totals: before migration 020 they are simply left out.
    const counts = memberStatuses(request.gymId).then(countStatuses, () => null);
    Promise.all([getGymSummary(request.gymId, { months }), counts])
        .then(([summary, statusCounts]) => {
            response.set("Cache-Control", "no-store");
            response.json({ status: "success", data: { ...summary, status_counts: statusCounts } });
        })
        .catch(next);
});

router.use(membersErrorHandler);

export default router;
