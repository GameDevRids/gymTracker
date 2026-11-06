import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import databaseRouter from "./routes/database.js";
import membersRouter from "./routes/members.js";
import plansRouter from "./routes/plans.js";
import membershipsRouter from "./routes/memberships.js";
import whatsappRouter from "./routes/whatsapp.js";
import { whatsappConfig } from "./config/whatsappConfig.js";

const app = express();
const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || "127.0.0.1";
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(currentDir, "..");
const allowedOrigins = new Set(whatsappConfig.allowedOrigins);
const apiToken = process.env.WHATSAPP_API_TOKEN || "";
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const requiresApiToken = process.env.NODE_ENV === "production" || !loopbackHosts.has(host);

if (requiresApiToken && !apiToken) {
    throw new Error("Set WHATSAPP_API_TOKEN when running in production or binding outside loopback.");
}

app.disable("x-powered-by");
app.use((request, response, next) => {
    const origin = request.get("Origin");
    if (origin && allowedOrigins.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Hub-Signature-256, X-WhatsApp-To, X-WhatsApp-Caption");
    }
    if (request.method === "OPTIONS") {
        return origin && allowedOrigins.has(origin) ? response.sendStatus(204) : response.sendStatus(403);
    }
    if (request.path.startsWith("/api/whatsapp/send") && (!origin || !allowedOrigins.has(origin))) {
        return response.status(403).json({ error: "WhatsApp sends require a browser origin listed in WHATSAPP_ALLOWED_ORIGINS." });
    }
    next();
});

app.use("/api/whatsapp", (request, response, next) => {
    if (request.path === "/webhook" || request.path.startsWith("/webhook/")) return next();
    if (!apiToken) return next();
    const supplied = Buffer.from(request.get("Authorization") || "");
    const expected = Buffer.from(`Bearer ${apiToken}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return response.status(401).json({ error: "A valid backend API access key is required." });
    }
    next();
});

app.use("/api/whatsapp/webhook", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use("/api", databaseRouter);
app.use("/api/members", membersRouter);
app.use("/api/plans", plansRouter);
app.use("/api/memberships", membershipsRouter);
app.use("/api/whatsapp", whatsappRouter);
app.use("/assets", express.static(path.join(projectDir, "assets")));
app.use("/data", express.static(path.join(projectDir, "data")));
app.get("/", (_request, response) => response.sendFile(path.join(projectDir, "index.html")));
app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.use((_request, response) => response.status(404).json({ error: "Not found." }));
app.use((error, _request, response, _next) => {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    response.status(status).json({ error: status === 500 ? "The server could not process this request." : error.message });
});

app.listen(port, host, () => {
    console.log(`GymPulse server listening on http://localhost:${port}`);
});
