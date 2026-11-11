import express from "express";
import { getMemberPayments, getPayments, getReceipt, paymentsErrorHandler, postPayment } from "../controllers/paymentsController.js";
import { validateMemberId } from "../middleware/validateMember.js";
import { validatePaymentId, validatePaymentListQuery, validatePaymentPayload } from "../middleware/validatePayment.js";

const router = express.Router();

router.get("/", validatePaymentListQuery, getPayments);
router.post("/", validatePaymentPayload, postPayment);
router.get("/member/:memberId", validateMemberId, getMemberPayments);
router.get("/:id/receipt", validatePaymentId, getReceipt);
router.use(paymentsErrorHandler);

export default router;
