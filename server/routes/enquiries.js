import express from "express";
import * as enquiries from "../services/enquiriesService.js";
import { membersErrorHandler } from "../controllers/membersController.js";
import { validateEnquiryChanges, validateEnquiryConsent, validateEnquiryContacted, validateEnquiryId, validateEnquiryJoin, validateNewEnquiry } from "../middleware/validateEnquiry.js";

// Enquiries (migration 024). Owners and staff alike. The gym and the staff member always come from
// the sign-in, never from the request.
export function createEnquiriesRouter(service = enquiries) {
    const router = express.Router();
    const context = (request) => ({ gymId: request.gymId, userId: request.authUser?.id || null });
    const send = (response, status = 200) => (data) => {
        response.set("Cache-Control", "no-store");
        response.status(status).json({ status: "success", data });
    };
    const fail = (response, next) => (error) => {
        // A duplicate says which member or enquiry it is, so the app can open it.
        if (error?.reason === "member_exists" || error?.reason === "enquiry_exists") {
            return response.status(409).json({ status: "error", message: error.message, code: error.reason, member_id: error.member_id, enquiry_id: error.enquiry_id });
        }
        return next(error);
    };

    router.get("/", (request, response, next) => {
        service.listEnquiries(request.gymId).then(send(response)).catch(next);
    });
    router.post("/", validateNewEnquiry, (request, response, next) => {
        service.createEnquiry(request.enquiryInput, context(request)).then(send(response, 201)).catch(fail(response, next));
    });
    router.put("/:id", validateEnquiryId, validateEnquiryChanges, (request, response, next) => {
        service.updateEnquiry(request.params.id, request.enquiryChanges, context(request)).then(send(response)).catch(fail(response, next));
    });
    router.post("/:id/consent", validateEnquiryId, validateEnquiryConsent, (request, response, next) => {
        service.setEnquiryConsent(request.params.id, request.enquiryConsent.agree, context(request)).then(send(response)).catch(next);
    });
    router.post("/:id/contacted", validateEnquiryId, validateEnquiryContacted, (request, response, next) => {
        service.markContacted(request.params.id, request.enquiryContacted, context(request)).then(send(response)).catch(next);
    });
    router.post("/:id/join", validateEnquiryId, validateEnquiryJoin, (request, response, next) => {
        service.joinEnquiry(request.params.id, request.enquiryJoin.member_id, context(request)).then(send(response)).catch(next);
    });
    router.delete("/:id", validateEnquiryId, (request, response, next) => {
        service.deleteEnquiry(request.params.id, context(request)).then(send(response)).catch(next);
    });
    router.use(membersErrorHandler);
    return router;
}

export default createEnquiriesRouter();
