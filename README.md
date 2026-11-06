# GymPulse

GymPulse is a responsive gym management prototype built with HTML, CSS, vanilla JavaScript modules, Chart.js, browser LocalStorage and an optional Node.js backend for WhatsApp Cloud API communication.

## Run locally

Run the WhatsApp backend and open the app at `http://localhost:3001`, or open `index.html` with VS Code Live Server (or another local static web server). JavaScript modules need a server origin; opening the file directly with `file://` may be blocked by the browser.

### Start the WhatsApp backend

1. Install Node.js 18.17 or newer.
2. In `server/`, run `npm install`.
3. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from your Supabase project settings. Keep the service-role key in the backend `.env` only; `.env` is ignored by Git.
4. Run the migrations in order in the Supabase SQL Editor: `server/migrations/001_create_members.sql` creates the initial members table.
   If `members` already existed before that migration, also run `server/migrations/002_align_members_table.sql` to add any missing columns without deleting records. Existing member dates are not fabricated; records missing dates need those dates supplied before they can be used as complete membership records.
   Run `server/migrations/003_create_membership_plans.sql` to create membership plans, then `server/migrations/004_create_member_memberships.sql` to create append-only assignment history and the atomic assignment function. Review each SQL file before pasting its contents into the Supabase SQL Editor and running it. Do not run migration 004 until migrations 001–003 are in place.
5. Run `npm start` in `server/`. The backend serves the existing frontend at `http://localhost:3001`; check database connectivity at `http://localhost:3001/api/db-test`.
6. In Meta, configure the webhook callback as `https://<your-public-host>/api/whatsapp/webhook`, subscribe to the `messages` field, and use the same verify token and app secret configured on the backend. The backend binds to loopback by default; deploy behind HTTPS and set an appropriate `HOST` (commonly `0.0.0.0`) only when protected by a trusted reverse proxy and authentication.
7. In GymPulse, leave messaging in Demo mode unless the backend reports that Meta credentials are configured. Switch to Live deliberately. If using Live Server, set the WhatsApp backend URL to `http://localhost:3001` and include the Live Server origin in `WHATSAPP_ALLOWED_ORIGINS`.

The backend sends text, approved-template and generated membership-card image messages through the official Meta Graph API. Incoming messages and delivery status updates are accepted only from webhook requests with a valid `X-Hub-Signature-256` signature. API acceptance is shown as **Accepted by Meta · awaiting status**; only webhook events update a message to sent, delivered, read or failed. API errors are shown as errors and are never replaced with simulated success.

For any non-loopback or production deployment, set a strong random `WHATSAPP_API_TOKEN`; the server refuses to start without it. Enter that key in the inbox's API access key field when using Live mode. GymPulse keeps this backend access key in tab-scoped `sessionStorage` (not the source code or persistent app data). The key is separate from Meta's access token, which remains in the backend environment.

The Chart.js dashboard charts load from a CDN. If the CDN is unavailable, the rest of the app continues to work and displays a chart fallback.

## Included prototype workflows

- Dashboard membership counts, expiry alerts and plan distribution use assigned membership history; revenue and attendance remain derived from their existing local demo records.
- Member search, status filters, sorting, profiles, add/edit/delete, CSV export and CSV import preview.
- Backend-backed membership plan management and member plan assignment history with immutable plan-detail snapshots, plus manual check-in/out and simulated QR/fingerprint attendance.
- Follow-up recommendations, analytics, report exports, notification previews, integrations status cards and workspace settings.
- A WhatsApp-style inbox with fictional Demo conversations, member ID card sends, editable message templates, manual live messaging and opt-in-gated inactive-member follow-ups.
- An optional Express backend with Meta Cloud API sends, media upload for member ID cards, webhook verification and in-memory message status tracking.
- Browser LocalStorage persistence and reset-to-demo-data action.

The fictional CSV import example is in [`data/sample-members.csv`](./data/sample-members.csv). Imports accept `name` and `phone` as required columns, plus optional `email`, `plan`, `joinedAt`, `startDate`, and `expiryDate`. Header matching ignores spaces, underscores, and hyphens; aliases include `fullName`, `mobile`, `phoneNumber`, and `joiningDate`. Optional date columns should use `YYYY-MM-DD`; plan values must match an active plan name, or may be left blank to use the first active plan. Existing or repeated phone numbers and invalid dates/plans are reported and skipped rather than overwritten.

## Important limitations

Demo mode uses fictional data and never sends real messages. Every simulated WhatsApp message is labelled DEMO and is not marked delivered. Live mode requires server-side Meta credentials; never put access tokens or app secrets in frontend files or browser storage. Live messages require the member to be marked as opted in. Template messages must match templates approved by Meta, and free-form messages are subject to Meta's customer-service-window rules.

This remains a prototype, not a production-secure SaaS. Member and conversation data is stored in browser LocalStorage and is not encrypted or backed up. The WhatsApp backend's webhook and message log are in memory and clear when its process restarts. There is no GymPulse owner login, per-user authorization, durable database, gym isolation, automated consent capture, opt-out processing or audit trail. A shared backend API token protects non-webhook routes in production, but the origin allowlist is not authentication and a shared token is not per-user authorization. Add authenticated owner access, rate limits, durable storage and gym-specific isolation before using live endpoints for a deployed service. Use real member data only after implementing those controls and reviewing applicable privacy and WhatsApp policies.

Fingerprint and QR actions remain simulations, and payments remain manual records. Integrate hardware, payment gateways or other gym systems only through their official APIs/SDKs after confirming product-specific support.
