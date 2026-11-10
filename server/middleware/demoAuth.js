import { createHash, timingSafeEqual } from "node:crypto";

function passwordDigest(value) {
    return createHash("sha256").update(value).digest();
}

export function requireDemoAuth(password = process.env.DEMO_PASSWORD) {
    return (request, response, next) => {
        if (!password || request.path === "/health") return next();

        const header = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(request.get("Authorization") || "");
        const decoded = header ? Buffer.from(header[1], "base64").toString("utf8") : "";
        const separator = decoded.indexOf(":");
        const username = separator > 0 ? decoded.slice(0, separator) : "";
        const suppliedPassword = separator > 0 ? decoded.slice(separator + 1) : "";
        const matches = timingSafeEqual(passwordDigest(suppliedPassword), passwordDigest(password));
        if (username && matches) return next();

        response.setHeader("WWW-Authenticate", 'Basic realm="GymPulse Demo"');
        return response.status(401).json({ error: "Demo password required." });
    };
}
