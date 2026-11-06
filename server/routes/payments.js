import express from "express";
import { getMemberPayments, paymentsErrorHandler, postPayment } from "../controllers/paymentsController.js";
import { validateMemberId } from "../middleware/validateMember.js";
import { validatePaymentPayload } from "../middleware/validatePayment.js";

const router = express.Router();

router.post("/", validatePaymentPayload, postPayment);
router.get("/member/:memberId", validateMemberId, getMemberPayments);
router.use(paymentsErrorHandler);

export default router;
