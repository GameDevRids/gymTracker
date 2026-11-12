const CACHE_NAME = "gympulse-shell-v13";
const APP_SHELL = [
    "/",
    "/index.html",
    "/manifest.webmanifest",
    "/assets/css/styles.css",
    "/assets/css/components.css",
    "/assets/css/responsive.css",
    "/assets/css/theme.css",
    "/assets/vendor/chart.umd.min.js",
    "/assets/vendor/qrcode-generator-1.4.4.js",
    "/assets/vendor/jsQR-1.4.0.js",
    "/assets/js/main.js",
    "/assets/js/state.js",
    "/assets/js/storage.js",
    "/assets/js/utils.js",
    "/assets/js/i18n.js",
    "/assets/js/api/apiClient.js",
    "/assets/js/api/membersApi.js",
    "/assets/js/api/membershipsApi.js",
    "/assets/js/api/paymentsApi.js",
    "/assets/js/api/plansApi.js",
    "/assets/js/components/charts.js",
    "/assets/js/components/modal.js",
    "/assets/js/components/skeleton.js",
    "/assets/js/components/tables.js",
    "/assets/js/components/toast.js",
    "/assets/js/modules/dashboard.js",
    "/assets/js/modules/expiring.js",
    "/assets/js/modules/memberImport.js",
    "/assets/js/modules/memberMemberships.js",
    "/assets/js/modules/members.js",
    "/assets/js/modules/operations.js",
    "/assets/js/modules/plans.js",
    "/assets/js/modules/whatsapp.js",
    "/assets/js/modules/welcome.js",
    "/assets/js/modules/welcomeUi.js",
    "/assets/js/welcomeMessage.js",
    "/assets/js/upi.js",
    "/assets/js/checkin.js",
    "/assets/js/modules/attendance.js",
    "/assets/js/modules/cardCanvas.js",
    "/assets/js/modules/upiPayments.js",
    "/assets/js/modules/checkinMethod.js",
    "/assets/js/modules/checkinSettingsUi.js",
    "/assets/js/entrance.js",
    "/assets/css/entrance.css",
    "/data/demo-data.js",
    "/assets/icons/gympulse-192.png",
    "/assets/icons/gympulse-512.png"
];

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("gympulse-shell-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
    )));
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== self.location.origin) return;
    // The entrance poster page is per phone and per poster: always from the network, never cached
    // (and never stored as the app's /index.html).
    if (url.pathname === "/c" || url.pathname.startsWith("/c/")) return;

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        event.respondWith(fetch(new Request(request, { cache: "no-store" })));
        return;
    }

    if (request.mode === "navigate") {
        event.respondWith(fetch(request)
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
                }
                return response;
            })
            .catch(async () => (await caches.match(url.pathname)) || caches.match("/index.html")));
        return;
    }

    if (APP_SHELL.includes(url.pathname)) {
        event.respondWith(fetch(new Request(request, { cache: "no-cache" }))
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname, copy));
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(url.pathname);
                if (cached) return cached;
                throw new Error(`GymPulse app shell resource is unavailable offline: ${url.pathname}`);
            }));
    }
});
