// Chooses where the server listens. Render sets RENDER=true and PORT itself, and must reach
// the server on all interfaces; locally the default stays loopback-only.
export function resolveListenAddress(environment = process.env) {
    const configuredHost = String(environment.HOST ?? "").trim();
    const configuredPort = String(environment.PORT ?? "").trim();
    const host = configuredHost || (environment.RENDER ? "0.0.0.0" : "127.0.0.1");
    const port = Number(configuredPort) || 3001;
    return {
        host,
        port,
        hostSource: configuredHost ? "HOST" : environment.RENDER ? "RENDER default" : "local default",
        portSource: Number(configuredPort) ? "PORT" : "default"
    };
}
