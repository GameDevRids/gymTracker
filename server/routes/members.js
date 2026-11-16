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
import { validateRenewPayload } from "../middleware/validateRenewal.js";
import { postRenew } from "../controllers/renewalsController.js";
import { validateMessageListQuery, validateMessagePayload } from "../middleware/validateWhatsAppMessage.js";
import { listMemberAttendance, reissueQrToken } from "../services/attendanceService.js";
import { listMemberDevices } from "../services/entranceService.js";
import {
    approvePendingPhoto,
    deleteMemberPhoto,
    memberPhoto,
    rejectPendingPhoto,
    setPhotoConsent,
    uploadMemberPhoto
} from "../services/memberPhotosService.js";
import { photoBody } from "../middleware/photoBody.js";
import { ownerOnly } from "../middleware/requireOwner.js";
import { validateImportPayload } from "../middleware/validateImport.js";
import { importMembers } from "../services/memberImportService.js";

const router = express.Router();

function reply(promise, response, next) {
    promise
        .then((data) => {
            response.set("Cache-Control", "no-store");
            response.json({ status: "success", data });
        })
        .catch(next);
}

// ---------- Member photo (migration 014). Own gym only; the member must agree first. ----------
// The member taps "I agree" (agree: true), or withdraws (agree: false, which deletes the photo).
router.post("/:id/photo-consent", validateMemberId, (request, response, next) => {
    const agree = request.body?.agree;
    if (typeof agree !== "boolean" || Object.keys(request.body || {}).length !== 1) {
        return response.status(400).json({ status: "error", message: "Send agree as true or false." });
    }
    reply(setPhotoConsent(request.params.id, request.gymId, { agree, source: "desk", recordedBy: request.authUser?.id || null }), response, next);
});
router.get("/:id/photo", validateMemberId, (request, response, next) => {
    reply(memberPhoto(request.params.id, request.gymId), response, next);
});
// The photo itself is the request body (JPEG or WebP, at most 300 KB).
router.put("/:id/photo", validateMemberId, photoBody, (request, response, next) => {
    reply(uploadMemberPhoto(request.params.id, request.gymId, request.body), response, next);
});
router.delete("/:id/photo", validateMemberId, (request, response, next) => {
    reply(deleteMemberPhoto(request.params.id, request.gymId), response, next);
});
router.post("/:id/photo/approve", validateMemberId, (request, response, next) => {
    reply(approvePendingPhoto(request.params.id, request.gymId), response, next);
});
router.post("/:id/photo/reject", validateMemberId, (request, response, next) => {
    reply(rejectPendingPhoto(request.params.id, request.gymId, request.authUser?.id || null), response, next);
});

// One-tap renewal (migration 019): the new plan, the payment and the renewal record in one
// transaction. 201 for a new renewal, 200 when the same key was already saved (a retry).
router.post("/:id/renew", validateMemberId, validateRenewPayload, postRenew);
router.get("/:memberId/memberships", validateMemberId, getMemberMemberships);
router.post("/:memberId/memberships", validateMemberId, validateAssignmentPayload, assignMemberPlan);
router.get("/", validateMemberListQuery, getMembers);
router.get("/:id", validateMemberId, getMember);
router.post("/", validateMemberPayload("create"), createMember);
// Import from a spreadsheet (migration 016): owner only, saved in one go or not at all.
router.post("/import", ownerOnly("Only the gym owner can import members."), validateImportPayload, (request, response, next) => {
    importMembers(request.importPayload, request.gymId)
        .then((result) => response.json({ status: "success", data: result }))
        .catch(next);
});
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
// Phones linked to the entrance poster for this member (approved and waiting).
router.get("/:id/devices", validateMemberId, (request, response, next) => {
    listMemberDevices(request.params.id, request.gymId)
        .then((rows) => response.json({ status: "success", data: rows }))
        .catch(next);
});
router.use(membersErrorHandler);

export default router;
