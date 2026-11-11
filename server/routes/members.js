import express from "express";
import {
    createMember,
    deleteMember,
    getMember,
    getConsentEvents,
    getMembers,
    getWhatsAppMessages,
    membersErrorHandler,
    recordWhatsAppMessage,
    setWhatsAppConsent,
    updateMember
} from "../controllers/membersController.js";
import {
    validateConsentPayload,
    validateMemberId,
    validateMemberListQuery,
    validateMemberPayload
} from "../middleware/validateMember.js";
import { assignMemberPlan, getMemberMemberships } from "../controllers/membershipsController.js";
import { validateAssignmentPayload } from "../middleware/validateMembership.js";
import { validateMessageListQuery, validateMessagePayload } from "../middleware/validateWhatsAppMessage.js";
import { listMemberAttendance, reissueQrToken } from "../services/attendanceService.js";

const router = express.Router();

router.get("/:memberId/memberships", validateMemberId, getMemberMemberships);
router.post("/:memberId/memberships", validateMemberId, validateAssignmentPayload, assignMemberPlan);
router.get("/", validateMemberListQuery, getMembers);
router.get("/:id", validateMemberId, getMember);
router.post("/", validateMemberPayload("create"), createMember);
router.put("/:id", validateMemberId, validateMemberPayload("update"), updateMember);
router.delete("/:id", validateMemberId, deleteMember);
// Consent history is append-only: there is deliberately no update or delete route for it.
router.put("/:id/consent/whatsapp", validateMemberId, validateConsentPayload, setWhatsAppConsent);
router.get("/:id/consent-events", validateMemberId, getConsentEvents);
router.get("/:id/whatsapp-messages", validateMemberId, validateMessageListQuery, getWhatsAppMessages);
router.post("/:id/whatsapp-messages", validateMemberId, validateMessagePayload, recordWhatsAppMessage);
router.get("/:id/attendance", validateMemberId, (request, response, next) => {
    listMemberAttendance(request.params.id, request.gymId)
        .then((rows) => response.json({ status: "success", data: rows }))
        .catch(next);
});
// A new QR token for a lost or shared card; the old QR stops working at once.
router.post("/:id/qr-token/reissue", validateMemberId, (request, response, next) => {
    reissueQrToken(request.params.id, request.gymId)
        .then((member) => response.json({ status: "success", data: member }))
        .catch(next);
});
router.use(membersErrorHandler);

export default router;
