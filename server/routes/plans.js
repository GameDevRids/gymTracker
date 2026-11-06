import express from "express";
import {
    createPlan,
    deletePlan,
    getPlan,
    getPlans,
    plansErrorHandler,
    updatePlan
} from "../controllers/plansController.js";
import {
    validatePlanId,
    validatePlanListQuery,
    validatePlanPayload
} from "../middleware/validatePlan.js";

const router = express.Router();

router.get("/", validatePlanListQuery, getPlans);
router.get("/:id", validatePlanId, getPlan);
router.post("/", validatePlanPayload("create"), createPlan);
router.put("/:id", validatePlanId, validatePlanPayload("update"), updatePlan);
router.delete("/:id", validatePlanId, deletePlan);
router.use(plansErrorHandler);

export default router;
