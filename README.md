# GymPulse

Track gym members.

GymPulse is a responsive gym management prototype built with HTML, CSS, vanilla JavaScript modules, Chart.js, Supabase-backed owner and gym data, and an optional WhatsApp Cloud API backend.

## Run locally

Run the WhatsApp backend and open the app at `http://localhost:3001`, or open `index.html` with VS Code Live Server (or another local static web server). JavaScript modules need a server origin; opening the file directly with `file://` may be blocked by the browser.

### Start the WhatsApp backend

1. Install Node.js 18.17 or newer.
2. In `server/`, run `npm install`.
3. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from your Supabase project settings. Keep the service-role key in the backend `.env` only; `.env` is ignored by Git.
4. Run the migrations in order in the Supabase SQL Editor: `server/migrations/001_create_members.sql` creates the initial members table.
   If `members` already existed before that migration, also run `server/migrations/002_align_members_table.sql` to add any missing columns without deleting records. Existing member dates are not fabricated; records missing dates need those dates supplied before they can be used as complete membership records.
   Run `server/migrations/003_create_membership_plans.sql` to create membership plans, then `server/migrations/004_create_member_memberships.sql` to create append-only assignment history and the atomic assignment function. Review each SQL file before pasting its contents into the Supabase SQL Editor and running it. Do not run migration 004 until migrations 001–003 are in place.
   Run and review `server/migrations/005_add_members_archived_at.sql` to enable member archiving. Run `server/migrations/006_create_payments.sql` to enable persistent member payments and receipts. Then run `server/migrations/007_create_gyms_and_auth.sql`. If a Supabase Auth user already exists, legacy rows go to that account's default gym. If there are no Auth users yet, the migration creates an unowned default gym for legacy rows; the first owner who completes gym onboarding claims it atomically, preserving access to that data.
5. Run `npm start` in `server/`. The backend serves the existing frontend at `http://localhost:3001`. Sign in with the Supabase Auth owner account and create a gym on first use.
6. In Meta, configure the webhook callback as `https://<your-public-host>/api/whatsapp/webhook`, subscribe to the `messages` field, and use the same verify token and app secret configured on the backend. The backend binds to loopback by default; deploy behind HTTPS and set an appropriate `HOST` (commonly `0.0.0.0`) only when protected by a trusted reverse proxy and authentication.
7. In GymPulse, leave messaging in Demo mode unless the backend reports that Meta credentials are configured. Switch to Live deliberately. If using Live Server, set the WhatsApp backend URL to `http://localhost:3001` and include the Live Server origin in `WHATSAPP_ALLOWED_ORIGINS`.

The default home view lists expired memberships and memberships ending within seven days; choose a 3, 7, 15, or 30-day window. Click-to-chat reminders use the editable template in WhatsApp settings and open WhatsApp without sending through Meta. Payment recording, history, and receipts use the backend and require migration 006.

To refill a disposable Supabase demo project, configure `DEMO_SUPABASE_URL`, `DEMO_SUPABASE_SERVICE_ROLE_KEY`, and `DEMO_GYM_ID` in the server environment and run `ALLOW_SEED=true npm run seed:demo` from `server/`. This deletes rows only from that gym before creating fictional replacements. Never point these demo-only variables at a production project.

Member names must be letters in any script, with spaces, dots, apostrophes or hyphens; empty names and email addresses are rejected by the forms, CSV import and the API. To list existing members whose names break that rule, run `npm run check:member-names` from `server/`. It only reads data.

The backend sends text, approved-template and generated membership-card image messages through the official Meta Graph API. Incoming messages and delivery status updates are accepted only from webhook requests with a valid `X-Hub-Signature-256` signature. API acceptance is shown as **Accepted by Meta · awaiting status**; only webhook events update a message to sent, delivered, read or failed. API errors are shown as errors and are never replaced with simulated success.

Chart.js is served locally. If the chart library is unavailable, the rest of the app continues to work and displays a chart fallback.

## Install on Android

Serve GymPulse over HTTPS (or `localhost` for local development), then open it in Chrome on Android and choose **Install app** or **Add to Home screen**. The app uses a standalone display, app icons and a service worker to cache its frontend shell for offline opening. API requests are always sent to the network and are never cached; membership and other backend data therefore still require a connection. Chart.js is bundled locally with the app.

## Deploy to Render

Create a Web Service with **Root Directory** `server`, **Build Command** `npm install`, **Start Command** `npm start`, and **Health Check Path** `/health`. Render supplies `PORT`; set these environment variables:

- Required: `HOST=0.0.0.0`, `NODE_ENV=production`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.
- Optional: `DEMO_PASSWORD` (puts the whole deployment behind a password; see below), `DEMO_GYM_IDS` (comma-separated gym IDs that may load fictional sample data from Settings; other gyms never see that option), `SENTRY_DSN` (enables error tracking), `LOG_LEVEL`, `META_GRAPH_API_VERSION` (defaults to `v22.0`), `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, and `WHATSAPP_ALLOWED_ORIGINS`.

### Demo password and sign-in limits

Set `DEMO_PASSWORD` to put every route except `/health` behind HTTP Basic Auth. The browser asks for a username and password; any username works with the configured password. The password is compared with `crypto.timingSafeEqual`. After a successful prompt the server sets a signed, HttpOnly cookie valid for 12 hours, marked `Secure` over HTTPS. The app needs it because its API calls send their own sign-in token in the same header the browser would use for the password. Changing `DEMO_PASSWORD` invalidates existing cookies. Leave it empty to disable the gate.

The gate also covers `/health/db` and the WhatsApp webhook. Meta cannot send the password, so leave `DEMO_PASSWORD` empty if you use live WhatsApp webhooks.

`POST /api/auth/login` and `POST /api/auth/refresh` each allow 10 requests per 15 minutes per client IP, and return HTTP 429 after that. Each page load uses one refresh request to restore the session. All other `/api` routes share a looser limit of 300 requests per 15 minutes. Client IPs are read from one trusted proxy hop, which matches Render.

Use only fictional demo data. Keep the WhatsApp Cloud API credentials empty unless you intentionally enable live messaging. Keep the Supabase service-role key private and use a demo-only Supabase project.

## Included prototype workflows

- Dashboard membership counts, expiry alerts and plan distribution use assigned membership history; revenue and attendance remain derived from their existing local demo records.
- Member search, status filters, sorting, profiles, add/edit/delete, CSV export and CSV import preview.
- Backend-backed membership plan management and member plan assignment history with immutable plan-detail snapshots, plus manual check-in/out. Plans are chosen in months (1, 3, 6 or 12) or as a custom number of days.
- Follow-up recommendations, analytics, report exports, notification previews, integrations status cards and workspace settings.
- A WhatsApp-style inbox with fictional Demo conversations, editable click-to-chat expiry reminders, member ID card sends, editable Meta templates, manual live messaging and opt-in-gated inactive-member follow-ups.
- An optional Express backend with Meta Cloud API sends, media upload for member ID cards, webhook verification and in-memory message status tracking.
- Outstanding balances come from the database: the fees of every non-cancelled membership minus every recorded payment, so they match on any device.
- Browser LocalStorage persistence, English/Hindi/Marathi navigation and form labels, and loading or clearing fictional sample data for demo accounts listed in `DEMO_GYM_IDS`.

The fictional CSV import example is in [`data/sample-members.csv`](./data/sample-members.csv). Imports accept `name` and `phone` as required columns, plus optional `email`, `plan`, `joinedAt`, `startDate`, and `expiryDate`. Header matching ignores spaces, underscores, and hyphens; aliases include `fullName`, `mobile`, `phoneNumber`, and `joiningDate`. Aliases also include `membershipPlan`. Optional date columns should use `YYYY-MM-DD`. Plan values must match an active plan name; rows without a plan are added without a membership. Phone numbers that already exist in the gym or repeat within the file, and invalid dates or plans, are reported and skipped rather than overwritten.

## Important limitations

Demo mode uses fictional data and never sends real messages. Every simulated WhatsApp message is labelled DEMO and is not marked delivered. Live mode requires server-side Meta credentials; never put access tokens or app secrets in frontend files or browser storage. Live messages require the member to be marked as opted in. Template messages must match templates approved by Meta, and free-form messages are subject to Meta's customer-service-window rules.

Owner sign-in uses Supabase Auth through the backend. The access token exists only in page memory. The refresh token is kept by the server in an HttpOnly, `SameSite=Strict` cookie limited to `/api/auth`, so page scripts cannot read it; it is marked `Secure` over HTTPS. On page load the app calls `/api/auth/refresh` to restore the session, so reloading and new tabs stay signed in until the browser is closed. Logout revokes the session with Supabase and always clears the cookie. Login, refresh and logout reject cross-site requests, and the frontend must be served from the same origin as the API for the session to persist. Protected API routes verify the access token, resolve the owner's gym, and scope database operations to that gym. Row Level Security also restricts authenticated Supabase access to linked gyms; the service-role key remains server-only. Signed Meta webhook endpoints are public unless `DEMO_PASSWORD` is set, and verify Meta's signature.

This remains a prototype, not a production-secure SaaS. Browser-stored settings and demo data are namespaced per signed-in user but are not encrypted; anyone with access to that browser profile can read them. The WhatsApp backend message log is in memory and is lost on restart. Incoming messages are associated with a gym only when the sender phone uniquely matches one gym's member record. Use fictional data, deploy behind HTTPS and a trusted reverse proxy, and do not use it as the sole recordkeeping system for a real gym.

Fingerprint and QR actions remain simulations, and payments remain manual records. Integrate hardware, payment gateways or other gym systems only through their official APIs/SDKs after confirming product-specific support.
