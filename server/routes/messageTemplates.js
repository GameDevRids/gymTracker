import express from "express";
import * as messages from "../services/whatsappMessagesService.js";
import { membersErrorHandler } from "../controllers/membersController.js";
import { validateTemplateBody, validateTemplateParams } from "../middleware/validateWhatsAppMessage.js";

const router = express.Router();

router.get("/:key", validateTemplateParams, (request, response, next) => {
    messages.listTemplates(request.params.key, request.gymId)
        .then((templates) => response.json({ status: "success", data: templates }))
        .catch(next);
});

router.put("/:key/:language", validateTemplateParams, validateTemplateBody, (request, response, next) => {
    messages.saveTemplate(request.params.key, request.params.language, request.validatedTemplateBody, request.authUser?.id || null, request.gymId)
        .then((template) => response.json({ status: "success", data: template }))
        .catch(next);
});

router.delete("/:key/:language", validateTemplateParams, (request, response, next) => {
    messages.resetTemplate(request.params.key, request.params.language, request.gymId)
        .then(() => response.json({ status: "success", message: "Template reset to the default." }))
        .catch(next);
});

router.use(membersErrorHandler);

export default router;
