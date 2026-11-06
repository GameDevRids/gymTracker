import express from "express";
import {
    createMember,
    deleteMember,
    getMember,
    getMembers,
    membersErrorHandler,
    updateMember
} from "../controllers/membersController.js";
import {
    validateMemberId,
    validateMemberListQuery,
    validateMemberPayload
} from "../middleware/validateMember.js";
import { assignMemberPlan, getMemberMemberships } from "../controllers/membershipsController.js";
import { validateAssignmentPayload } from "../middleware/validateMembership.js";

const router = express.Router();

router.get("/:memberId/memberships", validateMemberId, getMemberMemberships);
router.post("/:memberId/memberships", validateMemberId, validateAssignmentPayload, assignMemberPlan);
router.get("/", validateMemberListQuery, getMembers);
router.get("/:id", validateMemberId, getMember);
router.post("/", validateMemberPayload("create"), createMember);
router.put("/:id", validateMemberId, validateMemberPayload("update"), updateMember);
router.delete("/:id", validateMemberId, deleteMember);
router.use(membersErrorHandler);

export default router;
