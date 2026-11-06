import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { graphEndpoint, isCloudApiConfigured, whatsappConfig } from "../config/whatsappConfig.js";

const router = express.Router();
const messageLog = [];
const MESSAGE_LOG_LIMIT = 500;
const deliveryRank = { accepted: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

function recordMessage(message) {
    const index = messageLog.findIndex((entry) => entry.id && entry.id === message.id);
    if (index >= 0) {
        const existing = messageLog[index];
        const merged = { ...existing, ...message };
        if (existing.direction === "outbound" && message.direction === "outbound" &&
            (deliveryRank[existing.status] ?? -1) > (deliveryRank[message.status] ?? -1)) {
            merged.status = existing.status;
            merged.timestamp = existing.timestamp;
        }
        messageLog[index] = merged;
    } else messageLog.push(message);
    if (messageLog.length > MESSAGE_LOG_LIMIT) messageLog.splice(0, messageLog.length - MESSAGE_LOG_LIMIT);
    return message;
}

function digitsOnly(value) {
    return String(value || "").replace(/\D/g, "");
}

function validateRecipient(value) {
    const recipient = digitsOnly(value);
    if (recipient.length < 8 || recipient.length > 15) {
        const error = new Error("Recipient phone number must include 8 to 15 digits, including country code.");
        error.status = 400;
        throw error;
    }
    return recipient;
}

async function graphRequest(endpoint, payload) {
    let response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${whatsappConfig.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(20000)
        });
    } catch (error) {
        const failure = new Error(`Meta Cloud API request failed: ${error.message}`);
        failure.status = 502;
        throw failure;
    }
    let result;
    try {
        result = await response.json();
    } catch {
        const failure = new Error("Meta Cloud API returned an unreadable response.");
        failure.status = 502;
        throw failure;
    }
    if (!response.ok || result.error) {
        const detail = result.error?.message || `HTTP ${response.status}`;
        const failure = new Error(`Meta Cloud API rejected the request: ${detail}`);
        failure.status = 502;
        failure.metaError = result.error?.code || null;
        throw failure;
    }
    return result;
}

function ensureConfigured(_request, response, next) {
    if (!isCloudApiConfigured()) {
        return response.status(503).json({ error: "Meta WhatsApp Cloud API is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID on the server." });
    }
    next();
}

router.get("/status", (_request, response) => {
    const configured = isCloudApiConfigured();
    response.json({
        configured,
        webhookConfigured: Boolean(whatsappConfig.appSecret && whatsappConfig.verifyToken),
        message: configured ? "Meta Cloud API credentials are configured." : "Meta Cloud API credentials are not configured."
    });
});

router.get("/messages", (_request, response) => {
    response.json({ messages: messageLog.slice(-MESSAGE_LOG_LIMIT) });
});

router.post("/send", ensureConfigured, async (request, response, next) => {
    try {
        const { type, text, template } = request.body || {};
        const to = validateRecipient(request.body?.to);
        let payload;
        let preview = "";
        if (type === "text") {
            if (typeof text?.body !== "string" || !text.body.trim() || text.body.length > 4096) {
                return response.status(400).json({ error: "Text messages must contain 1 to 4096 characters." });
            }
            payload = { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: text.body, preview_url: Boolean(text.preview_url) } };
            preview = text.body;
        } else if (type === "template") {
            if (!template || !/^[a-z0-9_]{1,100}$/.test(template.name || "") || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(template.language?.code || "")) {
                return response.status(400).json({ error: "Provide a valid approved Meta template name and language code." });
            }
            payload = { messaging_product: "whatsapp", recipient_type: "individual", to, type: "template", template };
            preview = `Template: ${template.name}`;
        } else {
            return response.status(400).json({ error: "Message type must be text or template." });
        }

        const result = await graphRequest(graphEndpoint(`${whatsappConfig.phoneNumberId}/messages`), payload);
        const wamid = result.messages?.[0]?.id;
        if (!wamid) {
            return response.status(502).json({ error: "Meta accepted no message ID; delivery cannot be confirmed." });
        }
        recordMessage({ id: wamid, direction: "outbound", recipient: to, text: preview, status: "accepted", timestamp: new Date().toISOString() });
        response.status(202).json({ id: wamid, recipient: to, status: "accepted", timestamp: new Date().toISOString() });
    } catch (error) {
        next(error);
    }
});

router.post("/send-card", ensureConfigured, express.raw({ type: "image/png", limit: "5mb" }), async (request, response, next) => {
    try {
        if (!Buffer.isBuffer(request.body) || request.body.length < 8) {
            return response.status(400).json({ error: "Send a PNG membership card image." });
        }
        const to = validateRecipient(request.get("X-WhatsApp-To"));
        const caption = String(request.get("X-WhatsApp-Caption") || "").slice(0, 1024);
        const mediaForm = new FormData();
        mediaForm.append("messaging_product", "whatsapp");
        mediaForm.append("type", "image/png");
        mediaForm.append("file", new Blob([request.body], { type: "image/png" }), "membership-card.png");

        let mediaResponse;
        try {
            mediaResponse = await fetch(graphEndpoint(`${whatsappConfig.phoneNumberId}/media`), {
                method: "POST",
                headers: { Authorization: `Bearer ${whatsappConfig.accessToken}` },
                body: mediaForm,
                signal: AbortSignal.timeout(20000)
            });
        } catch (error) {
            const failure = new Error(`Meta media upload failed: ${error.message}`);
            failure.status = 502;
            throw failure;
        }
        let mediaResult;
        try {
            mediaResult = await mediaResponse.json();
        } catch {
            const failure = new Error("Meta media upload returned an unreadable response.");
            failure.status = 502;
            throw failure;
        }
        if (!mediaResponse.ok || mediaResult.error || !mediaResult.id) {
            const failure = new Error(`Meta media upload was rejected: ${mediaResult.error?.message || `HTTP ${mediaResponse.status}`}`);
            failure.status = 502;
            failure.metaError = mediaResult.error?.code || null;
            throw failure;
        }

        const result = await graphRequest(graphEndpoint(`${whatsappConfig.phoneNumberId}/messages`), {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "image",
            image: { id: mediaResult.id, ...(caption ? { caption } : {}) }
        });
        const wamid = result.messages?.[0]?.id;
        if (!wamid) return response.status(502).json({ error: "Meta accepted no message ID; delivery cannot be confirmed." });
        recordMessage({ id: wamid, direction: "outbound", recipient: to, text: caption || "Membership ID card", status: "accepted", timestamp: new Date().toISOString() });
        response.status(202).json({ id: wamid, recipient: to, status: "accepted", timestamp: new Date().toISOString() });
    } catch (error) {
        next(error);
    }
});

router.get("/webhook", (request, response) => {
    const mode = request.query["hub.mode"];
    const token = request.query["hub.verify_token"];
    const challenge = request.query["hub.challenge"];
    if (!whatsappConfig.verifyToken) return response.status(503).send("Webhook verification is not configured.");
    if (mode === "subscribe" && token === whatsappConfig.verifyToken && typeof challenge === "string") {
        return response.status(200).send(challenge);
    }
    response.sendStatus(403);
});

router.post("/webhook", (request, response) => {
    const body = request.body;
    if (!whatsappConfig.appSecret) return response.status(503).json({ error: "Webhook signature verification is not configured." });
    if (!Buffer.isBuffer(body)) return response.status(400).json({ error: "Expected a raw JSON webhook body." });
    const signature = request.get("X-Hub-Signature-256") || "";
    const expected = `sha256=${createHmac("sha256", whatsappConfig.appSecret).update(body).digest("hex")}`;
    const suppliedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
        return response.status(401).json({ error: "Invalid Meta webhook signature." });
    }

    let payload;
    try {
        payload = JSON.parse(body.toString("utf8"));
    } catch {
        return response.status(400).json({ error: "Webhook body is not valid JSON." });
    }
    if (payload.object !== "whatsapp_business_account") return response.sendStatus(404);
    for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
            for (const message of change.value?.messages || []) {
                const text = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || `[${message.type || "message"} received]`;
                recordMessage({ id: message.id, direction: "inbound", from: message.from, to: change.value?.metadata?.display_phone_number || "", text, type: message.type, status: "received", timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString() });
            }
            for (const status of change.value?.statuses || []) {
                recordMessage({ id: status.id, direction: "outbound", recipient: status.recipient_id, status: status.status || "unknown", timestamp: status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : new Date().toISOString(), error: status.errors?.[0]?.title || "" });
            }
        }
    }
    response.sendStatus(200);
});

router.use((error, _request, response, _next) => {
    if (response.headersSent) return;
    const status = Number.isInteger(error.status) ? error.status : 500;
    response.status(status).json({
        error: status === 500 ? "WhatsApp request failed unexpectedly." : error.message,
        ...(error.metaError ? { metaCode: error.metaError } : {})
    });
});

export default router;
