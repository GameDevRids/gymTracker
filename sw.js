const CACHE_NAME = "gympulse-shell-v29";
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
    "/assets/js/errorReporting.js",
    "/assets/js/passwordRules.js",
    "/assets/js/version.js",
    "/assets/js/legal.js",
    "/assets/js/workspace.js",
    "/assets/js/renewal.js",
    "/assets/js/memberStatus.js",
    "/assets/js/lapsedMessage.js",
    "/assets/js/modules/lapsed.js",
    "/assets/js/navigation.js",
    "/assets/js/followupMessage.js",
    "/assets/js/modules/settingsPage.js",
    "/assets/js/modules/renewalsPage.js",
    "/assets/js/holds.js",
    "/assets/js/holdMessage.js",
    "/assets/js/modules/holds.js",
    "/assets/js/modules/renewalSettingsUi.js",
    "/assets/js/modules/renewSheet.js",
    "/assets/js/modules/setupChecklist.js",
    "/assets/js/modules/account.js",
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
    "/assets/js/modules/memberImportUi.js",
    "/assets/js/spreadsheet.js",
    "/assets/js/modules/memberMemberships.js",
    "/assets/js/modules/members.js",
    "/assets/js/modules/operations.js",
    "/assets/js/modules/plans.js",
    "/assets/js/modules/welcome.js",
    "/assets/js/modules/welcomeUi.js",
    "/assets/js/welcomeMessage.js",
    "/assets/js/reminderMessage.js",
    "/assets/js/localDataMove.js",
    "/assets/js/modules/expiryReminder.js",
    "/assets/js/modules/summary.js",
    "/assets/js/modules/localData.js",
    "/assets/js/upi.js",
    "/assets/js/checkin.js",
    "/assets/js/modules/attendance.js",
    "/assets/js/modules/cardCanvas.js",
    "/assets/js/modules/upiPayments.js",
    "/assets/js/modules/checkinMethod.js",
    "/assets/js/modules/checkinSettingsUi.js",
    "/assets/js/entrance.js",
    "/assets/js/photoCapture.js",
    "/assets/js/modules/memberPhotos.js",
    "/assets/css/entrance.css",
    "/assets/icons/icon-192.png",
    "/assets/icons/icon-512.png",
    "/assets/icons/icon-maskable-512.png",
    "/assets/icons/apple-touch-icon.png",
    "/assets/icons/favicon.svg",
    "/assets/icons/favicon-32.png",
    "/assets/icons/favicon-16.png",
    "/assets/icons/mark-on-dark.svg",
    "/assets/icons/mark-on-light.svg"
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

/** Signed photo URLs from Supabase Storage, and the app's own photo endpoints. */
function isMemberPhoto(url) {
    return url.pathname.includes("/storage/v1/object/")
        || url.pathname.startsWith("/api/member-photos")
        || /^\/api\/members\/[^/]+\/photo/.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
    const request = event.request;
    const url = new URL(request.url);
    // Member photos (signed Supabase Storage URLs) and the photo API are never cached here.
    if (isMemberPhoto(url)) return;
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
