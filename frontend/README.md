# DataVault frontend

Next.js App Router, React, JavaScript, Tailwind CSS, and a custom responsive design system. All application data comes from the tenant API; test fixtures are confined to `tests/`.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci
# Copy .env.example to .env.local if it does not already exist.
npm run dev
```

Open http://localhost:3000. For production: `npm run build`, then `npm start`.

## Configuration

- `NEXT_PUBLIC_API_URL=https://datavault-saas.onrender.com` (no `/api` prefix)
- File controls are available in the vault. The backend remains the authority for upload quotas, permissions, and storage availability; an unavailable storage provider returns a friendly error.
- Browser requests use the same-origin `/backend` gateway, which forwards allowlisted tenant and platform-admin routes to `NEXT_PUBLIC_API_URL`, without adding any upstream prefix. The gateway forwards Bearer authorization and streams uploads/downloads; it never stores tokens or forwards cookies. Direct browser-to-Render clients still require exact allowed `CORS_ORIGIN` values.
- Render `ACCOUNT_ACTIVATION_URL` should be `https://<frontend>/activate`.
- Render `EMPLOYEE_INVITATION_URL` should be `https://<frontend>/employee-activate`.
- Do not copy backend secrets into this project.

## API contract

Read against `../FRONTEND_HANDOFF.md` and the deployed `/docs/openapi.json` on 2026-09-25.

| Feature | Endpoint | Notes |
| --- | --- | --- |
| Login, restore | POST /auth/sign-in; GET /auth/current-user | One-hour Bearer JWT in sessionStorage, cleared on logout/expiry; no cross-origin cookies |
| Register | POST /auth/sign-up | companyName, fullName, email, password, ISO alpha-2 country, industry |
| Google authentication | GET /auth/google; POST /auth/google/exchange or /auth/google/register | Existing accounts sign in; new accounts finish company details, then receive a tenant session |
| Activate, resend | POST /auth/verify-account; POST /auth/resend-verification | Token taken out of URL immediately; explicit activation avoids duplicate mutation under React Strict Mode |
| Join invitation | POST /invitations/accept | token, fullName, password; role/company assigned by backend |
| Company | GET/PATCH /companies/current | Only owner updates name, country, industry; company email is not an editable field |
| Profile/password | PATCH /users/:id; PATCH /users/me/password | fullName; currentPassword/newPassword |
| Overview | GET /statistics/current | Company-wide aggregates as explicitly exposed to both roles |
| Files | GET/POST /files; GET/DELETE /files/:id; GET /files/:id/download | Multipart file, visibility, JSON-array-string restrictedUserIds |
| Permissions | PATCH /files/:id/permissions | company_wide or restricted; owner or uploader |
| Employees | GET /users, /users/:id; PATCH/DELETE /users/:id | Owner can view and rename employees or remove access |
| Invitations | GET/POST /invitations; POST /invitations/:id/resend; DELETE /invitations/:id | Owner only; handle ambiguous email failure without automatic mutation retries |
| Plans | GET /plans; GET/PATCH /subscriptions/current | Both roles can read; only owner changes planCode |
| Billing estimate | GET /subscriptions/current/billing | Internal estimate, activation-anchored period; distinct from Stripe invoices |
| Stripe test billing | GET /payments/current; POST /payments/checkout, /payments/portal, /payments/plan, /payments/cancel, /payments/reconcile | Owner-only payment setup, invoices, plan changes, and explicit synchronization |
| Platform administration | POST /admin/auth/login, /admin/auth/forgot-password, /admin/auth/reset-password; GET /admin/dashboard, /admin/companies, /admin/users, /admin/files, /admin/audit-logs, /admin/access-requests; POST company suspend/reactivate and access-request decisions | Separate `/admin` session; bootstrap the first administrator with `npm run admin:bootstrap` |

## Backend limitations intentionally reflected in the UI

- File controls are available. The backend reports an error if storage is not configured; a live upload still requires working S3 credentials and a suitable tenant account.
- Workspace and platform-admin password recovery use their respective forgot-password and reset-password endpoints. All newly created passwords use the same 12–72 character, uppercase/lowercase, number, symbol, and 72 UTF-8 byte policy; sign-in continues to accept older passwords.
- There is no public invitation-preview endpoint, so the join page does not invent a company name.
- There is no audit log, notification feed, workspace switcher, storage byte quota, or invitation-created timestamp. The app does not fabricate these. File search, format/access filters, sorting, and usage views are the additional features.
- Members cannot list employees. Their permission editor can retain/remove existing recipient IDs or select themselves; administrators have a searchable directory. Unknown uploaders are shown as “Company member” rather than guessing a name.
- API list endpoints cap each page at 30. Files and directories fetch successive pages, with cancellation on navigation, so filtering covers the complete accessible collection. For very large tenants, backend search and cursor pagination would improve performance.
- A reused activation token is indistinguishable from an invalid/expired one (HTTP 400). The UI offers sign-in and resend instead of asserting which happened.

## Validation

`npm run build -- --webpack` checks production compilation. `npm test` runs Playwright against an already running localhost:3000 server, using Playwright Chromium. Tests mock the documented API only within the browser test process. They cover session redirects, expiry, member restrictions, 403 handling, permission payloads, activation token removal, Google registration, platform admin isolation, filtering, and mobile navigation/overflow. These are not substitutes for live authenticated integration tests.

No real account has been created or existing tenant data modified during development. A disposable activated account and test mailbox are needed to complete live registration, invitation, upload, and mutation testing.

## Verified results (2026-10-05)

- Next.js 16.3.6 production build passed.
- All 48 Playwright browser tests passed, including three live public API checks. The remaining tests intercept API responses.
- Live `/plans` returned the documented Free/Basic/Premium catalog through the gateway; live `/auth/current-user` correctly rejected missing authentication with HTTP 401.
- The deployed backend readiness endpoint reported MongoDB up. Local S3 credentials passed a temporary object upload, readback, and deletion check. Stripe Test Mode catalog and portal settings matched the backend's configuration checks.
- The frontend npm audit reported zero vulnerabilities. The employee editor was reviewed at desktop and 390px mobile widths.
- Authenticated tenant mutations remain unverified against real accounts; no credentials were provided.

## Google authentication and registration

`/login` and `/auth/sign-in` share the auth page. Google starts with a normal browser navigation to `${NEXT_PUBLIC_API_URL}/auth/google`, so the backend can set and validate its HttpOnly state cookie. Existing active users return to `/auth/sign-in#code=...` and exchange that one-use code through `POST /auth/google/exchange`. New users return to `/register#google_code=...`, enter company name, country, and industry, and submit `POST /auth/google/register`. The backend verifies the Google email and creates an activated owner, company, and Free subscription. The frontend removes codes from browser history, keeps tokens in sessionStorage, verifies `/auth/current-user`, and prevents an older session restore from replacing a new sign-in. The gateway does not proxy Google start/callback or forward OAuth cookies.

Configure Vercel `NEXT_PUBLIC_API_URL=https://datavault-saas.onrender.com`; configure Render `FRONT_URI=https://datavault-saas.vercel.app`, `GOOGLE_CALLBACK_URL=https://datavault-saas.onrender.com/auth/google/callback`, and the Google client ID/secret. Register that exact callback in Google. If the consent screen is in testing mode, allow the test user. Rebuild the frontend after changing public environment variables. Keep the client secret only on Render.

A real HTTPS GET `/auth/google` returned 403 on 2026-09-28 because the deployed backend did not recognize the proxy's HTTPS request. The live browser test on 2026-10-02 received the expected 302 redirect with secure state cookie, so OAuth start is now reachable. Full Google consent, new-account completion, and existing-account sign-in still need a real browser check.

For a live check, try one new Google email and complete company details, then sign out and use Google again with the same email. Confirm the first path creates a workspace and the second signs in without asking for company details. Also check an existing activated email/password account, an inactive account, cancellation, and mobile layout. The browser tests use intercepted API responses; they do not prove live Google consent or provider configuration.

## AI Assistant

The persistent lower-right chat widget integrates POST `/ai/chat`, GET `/ai/conversations?page=1&limit=20`, GET `/ai/conversations/:id`, and DELETE `/ai/conversations/:id`. Both roles have access to their own conversations. Model/provider configuration is server-controlled. If the backend returns `ai_disabled`, the page disables sending and explains that the service needs enabling; saved history remains readable. No API key is needed or accepted by this frontend. See `BACKEND_FEATURE_AUDIT.md` for the full feature comparison and deployment prerequisites.

The chatbot opens over the current page, preserves its draft when minimized or during client navigation, and has an inline History view. The login screen shows a sign-in prompt. The former /dashboard/assistant route redirects to the dashboard with chat open.

## Stripe return routes and backend setup

Verified against deployed Swagger and the backend payment service on 2026-09-27. The current backend supports **Stripe test mode only**. No frontend Stripe secret, publishable key, or Stripe SDK is needed; the server creates hosted sessions.

Configure these on **Render**, using the exact origin where this frontend runs:

```env
STRIPE_CHECKOUT_SUCCESS_URL=https://<frontend-host>/payments/success
STRIPE_CHECKOUT_CANCEL_URL=https://<frontend-host>/payments/cancel
STRIPE_PORTAL_RETURN_URL=https://<frontend-host>/payments/return
```

For local development, these pages exist at `http://localhost:3000/payments/success`, `/payments/cancel`, and `/payments/return`. Backend validation permits HTTP localhost callbacks only outside production; with `NODE_ENV=production`, **all three callback URLs must use HTTPS**, including localhost. A deployed HTTPS frontend or an explicitly configured HTTPS development origin is needed for that environment. `/settings/billing` is a compatibility alias for the backend's previous example portal return URL. No `session_id` query parameter is required: state is fetched using the authenticated company. Query parameters never prove payment, select a plan, or supply a redirect destination, and are removed on the return pages. The existing sessionStorage bearer survives same-tab Stripe navigation; expired sessions are sent through sign-in with a tightly allowlisted return path.

The server must enable `STRIPE_ENABLED` and configure its test secret, catalog, webhook, and restricted portal before hosted flows work. The frontend discovers availability through owner-only `GET /payments/current`. A generic outage blocks plan mutations; only the explicit disabled response allows the existing unpaid workspace-plan assignment. Stripe-managed accounts may still reject assignment on the backend.

Checkout saves a test payment method and does not collect payment immediately. Existing paid subscriptions use `/payments/plan`; Free uses `/payments/cancel`. Pending changes and period-end cancellation are displayed from server state, including a Keep-current-plan action. Return pages perform only reads until the owner explicitly chooses Synchronize with Stripe. No mutation is automatically retried.

Billing tests use isolated provider responses for disabled/outage states, checkout payload and redirect, scheduled cancellation and keeping a plan, pending/success returns, reconciliation, session return routing, employee restrictions, invoice URL validation, and portal redirects. These checks do not substitute for an end-to-end Stripe test transaction with configured backend credentials.
