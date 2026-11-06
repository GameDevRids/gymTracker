const sentry = process.env.SENTRY_DSN ? await import("@sentry/node") : null;

if (sentry) {
    sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || "development"
    });
}

export function captureException(error) {
    sentry?.captureException(error);
}
