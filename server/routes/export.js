import express from "express";
import { buildGymWorkbook } from "../services/exportService.js";
import { ownerOnly } from "../middleware/requireOwner.js";
import { membersErrorHandler } from "../controllers/membersController.js";

const router = express.Router();

// GET /api/export/workbook — the owner's full copy of the gym's data as one Excel file.
router.get("/workbook", ownerOnly("Only the gym owner can download all of the gym's data."), async (request, response, next) => {
    try {
        const bytes = await buildGymWorkbook(request.gymId);
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
        response.set({
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="gympulse-data-${day}.xlsx"`,
            "Cache-Control": "no-store"
        });
        response.send(Buffer.from(bytes));
    } catch (error) {
        next(error);
    }
});

router.use(membersErrorHandler);

export default router;
