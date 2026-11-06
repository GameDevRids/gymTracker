const graphVersion = process.env.META_GRAPH_API_VERSION || "v22.0";

export const whatsappConfig = {
    graphVersion,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    appSecret: process.env.WHATSAPP_APP_SECRET || "",
    verifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "",
    allowedOrigins: (process.env.WHATSAPP_ALLOWED_ORIGINS || "http://localhost:3001,http://127.0.0.1:3001,http://localhost:5500,http://127.0.0.1:5500")
        .split(",").map((origin) => origin.trim()).filter(Boolean)
};

export function isCloudApiConfigured() {
    return Boolean(whatsappConfig.accessToken && whatsappConfig.phoneNumberId);
}

export function graphEndpoint(resource) {
    return `https://graph.facebook.com/${whatsappConfig.graphVersion}/${resource}`;
}
