import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { httpLogger, logger } from "./config/logger.js";
import { captureException } from "./config/monitoring.js";
import databaseRouter from "./routes/database.js";
import membersRouter from "./routes/members.js";
import plansRouter from "./routes/plans.js";
import membershipsRouter from "./routes/memberships.js";
import paymentsRouter from "./routes/payments.js";
import whatsappRouter from "./routes/whatsapp.js";
import authRouter from "./routes/auth.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { supabaseClient, supabaseConfigured } from "./config/database.js";
import { whatsappConfig } from "./config/whatsappConfig.js";

export const app = express();
const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || "127.0.0.1";
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const currentFile = fileURLToPath(import.meta.url);
const projectDir = path.resolve(currentDir, "..");
const allowedOrigins = new Set(whatsappConfig.allowedOrigins);
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(httpLogger);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            styleSrcAttr: ["'unsafe-inline'"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'"]
        }
    }
}));
app.use(compression());
app.use("/api", rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false
}));
app.use("/api/whatsapp/send", rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false
}));
app.use((request, response, next) => {
    const origin = request.get("Origin");
    if (origin && allowedOrigins.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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

app.use("/api/whatsapp/webhook", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", authRouter);
app.use("/api", databaseRouter);
app.use("/api/members", requireAuth(), membersRouter);
app.use("/api/plans", requireAuth(), plansRouter);
app.use("/api/memberships", requireAuth(), membershipsRouter);
app.use("/api/payments", requireAuth(), paymentsRouter);
app.use("/api/whatsapp", (request, response, next) => {
    if (request.path === "/webhook" || request.path.startsWith("/webhook/")) return next();
    return requireAuth()(request, response, next);
});
app.use("/api/whatsapp", whatsappRouter);
app.use("/assets", express.static(path.join(projectDir, "assets")));
app.use("/data", express.static(path.join(projectDir, "data")));
app.get("/manifest.webmanifest", (_request, response) => response.sendFile(path.join(projectDir, "manifest.webmanifest")));
app.get("/sw.js", (_request, response) => {
    response.setHeader("Service-Worker-Allowed", "/");
    response.sendFile(path.join(projectDir, "sw.js"));
});
app.get("/index.html", (_request, response) => response.sendFile(path.join(projectDir, "index.html")));
app.get("/", (_request, response) => response.sendFile(path.join(projectDir, "index.html")));
app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.get("/health/db", async (_request, response) => {
    if (!supabaseConfigured || !supabaseClient) {
        return response.status(503).json({ status: "error", message: "Database unavailable." });
    }

    try {
        const { error } = await supabaseClient.from("members").select("id").limit(1);
        if (error) {
            return response.status(503).json({ status: "error", message: "Database unavailable." });
        }
        return response.json({ status: "ok" });
    } catch {
        return response.status(503).json({ status: "error", message: "Database unavailable." });
    }
});
app.use((_request, response) => response.status(404).json({ error: "Not found." }));
app.use((error, _request, response, _next) => {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) {
        logger.error({ err: error }, "Request failed.");
        captureException(error);
    }
    response.status(status).json({ error: status === 500 ? "The server could not process this request." : error.message });
});

function startServer() {
    const server = app.listen(port, host, () => {
        logger.info({ host, port }, "GymPulse server listening.");
    });
    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info({ signal }, "Shutdown signal received; closing the server.");
        server.close((error) => {
            if (error) {
                logger.error({ err: error }, "The server could not close cleanly.");
                process.exitCode = 1;
            }
            process.exit(process.exitCode || 0);
        });
        server.closeIdleConnections?.();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
    return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
    startServer();
}
