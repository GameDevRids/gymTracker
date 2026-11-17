import express from "express";
import { getGymSummary } from "../services/summaryService.js";
import { countStatuses, inactiveCount, memberStatuses, recentVisitorIds, renewalStats } from "../services/memberStatusService.js";
import { dueEnquiryCount } from "../services/enquiriesService.js";
import { membersErrorHandler } from "../controllers/membersController.js";

const router = express.Router();

// GET /api/summary?months=6 — gym-wide totals for the Overview, Analytics and Payments pages.
router.get("/", (request, response, next) => {
    const months = request.query.months === undefined ? 6 : Number(request.query.months);
    if (!Number.isInteger(months) || months < 1 || months > 24) {
        return response.status(400).json({ status: "error", message: "months must be a whole number from 1 to 24." });
    }
    // Worked out from the shared status rule, so the Overview, Analytics and the lists agree. They
    // never hold up the totals: if they fail, the database's own figures are kept.
    const statuses = Promise.all([memberStatuses(request.gymId), recentVisitorIds(request.gymId)])
        .then(([rows, visitors]) => ({ statusCounts: countStatuses(rows), renewals: renewalStats(rows), inactive: inactiveCount(rows, visitors) }), () => null);
    // Before migration 024 there are no enquiries: the count is simply left out.
    const enquiriesDue = dueEnquiryCount(request.gymId).catch(() => null);
    Promise.all([getGymSummary(request.gymId, { months }), statuses, enquiriesDue])
        .then(([summary, extra, enquiries]) => {
            response.set("Cache-Control", "no-store");
            response.json({ status: "success", data: {
                ...summary,
                status_counts: extra?.statusCounts ?? null,
                enquiries_due: enquiries,
                ...(extra ? {
                    due_last_30_days: extra.renewals.due,
                    renewed_last_30_days: extra.renewals.renewed,
                    inactive_members: extra.inactive
                } : {})
            } });
        })
        .catch(next);
});

router.use(membersErrorHandler);

export default router;
