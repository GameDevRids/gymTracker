import express from "express";
import { getMemberPayments, getPayments, getReceipt, paymentsErrorHandler, postPayment, postVoidPayment } from "../controllers/paymentsController.js";
import { ownerOnly } from "../middleware/requireOwner.js";
import { validateMemberId } from "../middleware/validateMember.js";
import { validatePaymentId, validatePaymentListQuery, validatePaymentPayload, validateVoidPayload } from "../middleware/validatePayment.js";

const router = express.Router();

router.get("/", validatePaymentListQuery, getPayments);
router.post("/", validatePaymentPayload, postPayment);
router.get("/member/:memberId", validateMemberId, getMemberPayments);
router.get("/:id/receipt", validatePaymentId, getReceipt);
// Voiding: owners only. The payment stays, with its receipt number, marked voided.
router.post("/:id/void", ownerOnly("Only the gym owner can void a payment."), validatePaymentId, validateVoidPayload, postVoidPayment);
router.use(paymentsErrorHandler);

export default router;
