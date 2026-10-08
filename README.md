# DataVault SaaS backend

NestJS backend for DataVault with company-based tenant isolation, internal plan/subscription entitlements, email onboarding, and private CSV/XLS/XLSX file storage. An optional Stripe Test Mode integration uses hosted card setup and company subscriptions; assignment mode remains available without Stripe.

## Local setup

Use Node.js 24 (see `.nvmrc`) and npm:

```bash
npm ci
cp .env.example .env
npm run start:dev
```

`MONGO_URI`, a random `JWT_SECRET` of at least 32 characters, `ACCOUNT_ACTIVATION_URL`, `EMPLOYEE_INVITATION_URL`, `EMAIL_PROVIDER`, and that provider's required settings must be configured. The two application URLs should point to frontend pages that read the token and call `/auth/verify-account` or `/invitations/accept`, respectively. The application validates configuration during startup and requires HTTPS for non-local application URLs. Every supported setting is documented in `.env.example`.

### Continuous integration

`.github/workflows/ci.yml` runs on pushes and pull requests to `main`. It uses Node 24 from `.nvmrc` and `npm ci`, then checks formatting, ESLint, the production build, the complete unit and HTTP e2e suites (including Swagger/OpenAPI tests), and high/critical npm advisories. CI supplies only explicit, non-secret test placeholders. The tests mock MongoDB and external providers; CI uses no Atlas database, Stripe, S3, SMTP, OpenRouter, Google OAuth, or repository secrets. The Dockerfile is not built or published by CI because the same application build is already checked and no container registry or deployment target has been selected.

### OpenAPI documentation

With the API running locally, the interactive Swagger UI is available at `http://localhost:3000/docs` and the generated OpenAPI JSON document at `http://localhost:3000/docs/openapi.json`. The document is generated from the current Nest controllers and DTO validation metadata; generating it in tests does not initialize MongoDB or call Stripe, S3, SMTP, or OpenRouter.

For the deployed Render staging API and frontend integration contract, see [FRONTEND_HANDOFF.md](FRONTEND_HANDOFF.md).

Swagger defines two deliberately separate Bearer schemes:

- **tenant-jwt** accepts the JWT returned by `POST /auth/sign-in` and applies only to activated company-owner/member endpoints.
- **platform-admin-jwt** accepts the JWT returned by `POST /admin/auth/login` and applies only to the isolated `/admin` surface.

Use Swagger UI's **Authorize** action for the matching scheme and paste only the JWT value. Do not save a real token in source, documentation, shared API collections, screenshots, or examples. A token from one scheme cannot authorize the other API surface. Public activation, invitation acceptance, health, plan-catalog, OAuth, and signed Stripe-webhook operations are marked without Bearer authentication according to their actual guards.

## Production configuration

Set configuration in the deployment environment or secret manager; never bake `.env` files into an image. The repository ignores all `.env*` files except the placeholder-only `.env.example`.

### MongoDB

| Variable                            | Required | Purpose                                                                                                                         |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `MONGO_URI`                         | Yes      | MongoDB Atlas or another replica-set/sharded-cluster URI. Include the database name and TLS options required by the deployment. |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | No       | Driver server-selection timeout; defaults to 10,000 ms.                                                                         |
| `MONGO_MAX_POOL_SIZE`               | No       | Per-process connection-pool maximum; defaults to 20. Size the aggregate across all replicas.                                    |
| `MONGO_RETRY_ATTEMPTS`              | No       | Nest startup connection attempts; defaults to 5.                                                                                |
| `MONGO_RETRY_DELAY_MS`              | No       | Delay between startup attempts; defaults to 3,000 ms.                                                                           |

Transactions are mandatory. Company registration, invitation acceptance, employee-seat reservation, plan changes, and upload quota/metadata accounting rely on multi-document transactions. A standalone MongoDB is unsupported. Startup executes MongoDB's `hello` command and refuses to serve traffic unless logical sessions and either a replica set or sharded cluster are present. It also waits for registered Mongoose model indexes, including uniqueness constraints, before serving HTTP. Initial connection or index failures stop startup; operations never fall back to non-transactional writes.

The fresh application keeps Mongoose automatic index creation enabled so required unique, partial, TTL, and tenant query indexes are created from the schemas. The database identity therefore needs normal application read/write and index-creation permissions. Review index creation before adding this application to a populated legacy database; no migration is required for a fresh deployment.

### JWT and application

| Variable                  | Required            | Purpose                                                                                                               |
| ------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`              | Yes                 | Random signing secret of at least 32 characters. Store only in a secret manager.                                      |
| `NODE_ENV`                | Production          | Set to `production`; accepted values are `development`, `test`, and `production`.                                     |
| `PORT`                    | No                  | Listening port supplied by the platform; defaults to 3000. The process binds `0.0.0.0`.                               |
| `TRUST_PROXY_HOPS`        | No                  | Exact number of trusted reverse-proxy hops; defaults to 0. Configure only after confirming the provider network path. |
| `CORS_ORIGIN`             | Browser deployments | Comma-separated explicit frontend HTTPS origins. Blank disables CORS; wildcards and paths are rejected.               |
| `ACCOUNT_ACTIVATION_URL`  | Yes                 | HTTPS frontend URL that consumes the company activation token.                                                        |
| `EMPLOYEE_INVITATION_URL` | Yes                 | HTTPS frontend URL that consumes the employee invitation token.                                                       |

JWTs use HS256 with a one-hour lifetime and an explicit algorithm allowlist. Helmet supplies standard security headers. DTO validation strips no unknown values silently: unknown fields are rejected. CORS does not allow credentials and never defaults to a wildcard. Public sign-in, registration, verification, resend, and invitation acceptance routes are rate-limited in memory. A horizontally scaled deployment should replace that limiter store with a shared implementation and set `TRUST_PROXY_HOPS` to the verified proxy chain.

### Transactional email

`EMAIL_PROVIDER` is required and must be `smtp` or `resend`; the choice is independent of `NODE_ENV`. Auth and invitation services create the same plaintext activation/invitation messages and links through one sender interface. Exactly one provider handles each attempt; there is no automatic fallback or cross-provider retry.

| Variable                     | Required when             | Purpose                                                            |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `SMTP_HOST`                  | `EMAIL_PROVIDER=smtp`     | SMTP hostname or IP address.                                       |
| `SMTP_FROM`                  | `EMAIL_PROVIDER=smtp`     | Plain sender email address.                                        |
| `SMTP_PORT`                  | Optional in SMTP mode     | Defaults to 587, or 465 when implicit TLS is enabled.              |
| `SMTP_SECURE`                | Optional in SMTP mode     | `true` for implicit TLS, normally port 465; defaults to `false`.   |
| `SMTP_REQUIRE_TLS`           | Optional in SMTP mode     | Requires STARTTLS when not using implicit TLS; defaults to `true`. |
| `SMTP_USER`, `SMTP_PASSWORD` | Optional pair in SMTP mode | Configure both or neither.                                         |
| `RESEND_API_KEY`             | `EMAIL_PROVIDER=resend`   | Backend-only Resend API key, stored as a deployment secret.         |
| `RESEND_FROM`                | `EMAIL_PROVIDER=resend`   | Plain email address on a verified Resend sender domain.            |

Local development can keep Nodemailer/Gmail with `EMAIL_PROVIDER=smtp`. SMTP connection, greeting, and socket timeouts are bounded; Nodemailer file and URL access are disabled. **Render Free blocks outbound SMTP ports 25, 465, and 587**, so the Gmail SMTP path is not suitable there. Brevo supports SMTP on port 2525, which the existing SMTP sender can use without code changes. For a Render deployment without a sending domain, create and verify a Brevo sender, enable transactional sending, and set these backend environment variables:

```env
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=2525
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_FROM=<verified sender email>
SMTP_USER=<Brevo SMTP login>
SMTP_PASSWORD=<Brevo SMTP key>
```

Get the SMTP login and key from Brevo's SMTP settings; the key is different from its API key. Keep the key in Render's environment, never in source control or frontend variables. Brevo may replace a sender on a free mailbox domain with its own address, and delivery still depends on account approval and receiving mailboxes. Test activation and invitation delivery to separate real inboxes before opening registration. A signup whose activation email failed is already saved: use `/auth/resend-verification` or the frontend's **Resend activation** form after fixing delivery, rather than registering the same address again. See [Brevo SMTP setup](https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP), [port 2525](https://help.brevo.com/hc/en-us/articles/10905415650322-Which-SMTP-port-should-I-use-Port-587-465-or-2525), and [sender handling](https://help.brevo.com/hc/en-us/articles/14925263522578-Comply-with-Gmail-Yahoo-and-Microsoft-s-requirements-for-email-senders).

Alternatively, verify a sending domain in Resend, create a send-only API key, set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and `RESEND_FROM` in Render, and omit SMTP variables. Resend delivery uses HTTPS with a 10-second timeout; provider errors and response bodies are never forwarded to clients or logged. Both frontend application URLs remain required and provider-independent.

Registration commits the inactive company, owner, Free subscription, and verification record before requesting delivery. If delivery fails, signup returns a sanitized 503 even though registration was saved; resend-verification remains available. Invitation creation similarly commits the pending invitation before delivery, then returns a sanitized 503 if sending fails; the owner can resend it later. These semantics do not depend on the selected provider.

### AWS S3 and files

| Variable                                     | Required                            | Purpose                                                                              |
| -------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| `AWS_BUCKET_NAME`                            | File operations                     | Private S3 bucket.                                                                   |
| `AWS_REGION`                                 | File operations                     | Region containing the bucket.                                                        |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | No                                  | Explicit credential pair. Prefer the platform IAM role/default AWS credential chain. |
| `AWS_SESSION_TOKEN`                          | Temporary explicit credentials only | Session token; requires the explicit credential pair.                                |
| `FILE_MAX_SIZE_BYTES`                        | No                                  | Buffered multipart limit; defaults to 10 MiB and is capped at 100 MiB.               |

Keep S3 Block Public Access enabled and enable bucket default encryption. The runtime principal needs only `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` on `arn:aws:s3:::BUCKET/companies/*`; the application does not list the bucket, set public ACLs, or use permanent public URLs. Align provider/proxy body limits and memory with `FILE_MAX_SIZE_BYTES`.

### Optional Google OAuth

| Variable                                   | Required together | Purpose                                                           |
| ------------------------------------------ | ----------------- | ----------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Yes, when enabled | OAuth client credentials.                                         |
| `GOOGLE_CALLBACK_URL`                      | Yes, when enabled | HTTPS backend `/auth/google/callback` URL registered with Google. |
| `FRONT_URI`                                | Yes, when enabled | HTTPS frontend origin receiving the completed sign-in redirect.   |

Leaving all four Google variables blank disables Google OAuth. The browser navigates to `GET /auth/google`. The backend stores hashed, single-use state in MongoDB and binds it to an HttpOnly, SameSite=Lax cookie. On HTTPS it uses a host-only `__Host-` cookie (Secure, `Path=/`); localhost HTTP development uses a callback-path-scoped cookie. After Google verifies the email, existing active users return to `/auth/sign-in#code=...` and exchange the one-minute code through `POST /auth/google/exchange`. New users return to `/register#google_code=...`, enter company name, country, and industry, then call `POST /auth/google/register`. This creates an activated company, owner, and Free subscription atomically; no password or activation email is needed. The five-minute registration code is consumed in that transaction, so a failed company-name attempt can be corrected before expiry. Both frontend pages immediately remove codes from browser history. Use HTTPS for both origins in production, register the exact backend callback with Google, allow the frontend origin in `CORS_ORIGIN`, and share one MongoDB database across backend instances. Google initiation, callback, and exchange reject non-HTTPS requests in production; behind TLS termination, set `TRUST_PROXY_HOPS` to the exact trusted proxy count and keep the listener private. Do not log exchange codes or include them in analytics.

### Optional AI providers: OpenRouter primary, direct Gemini fallback

The AI assistant is disabled by default. OpenRouter remains primary, including its configured model-level fallback routing. If its first model round fails with HTTP 429, a provider/network timeout, or an eligible 5xx/unavailable error, and Gemini is enabled, the backend tries Google's direct Gemini API once. A successful first round pins that provider for the rest of the current tool exchange, preserving its function-call history; the next user turn starts with OpenRouter again. Invalid responses, authentication/credit errors, 4xx configuration errors and local application failures do not trigger provider fallback. Gemini can also run alone when OpenRouter is disabled. Browser clients cannot provide model IDs, token budgets, usage, prices, tenant IDs, or tool authorization context.

| Variable                            | Required when enabled | Purpose                                                                                                  |
| ----------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_ENABLED`                | No                    | Explicit opt-in; defaults to `false`.                                                                    |
| `OPENROUTER_API_KEY`                | Yes                   | Backend-only OpenRouter key. Store in a secret manager.                                                  |
| `OPENROUTER_MODEL`                  | Yes                   | Server-controlled primary `provider/model` ID. Select a model that supports OpenAI-compatible tools.     |
| `OPENROUTER_FALLBACK_MODELS`        | No                    | Up to three distinct, comma-separated, tool-capable fallback model IDs in routing order.                 |
| `OPENROUTER_TIMEOUT_MS`             | No                    | Complete request timeout per provider round; defaults to 30 seconds, range 5–120 seconds.                |
| `OPENROUTER_MAX_OUTPUT_TOKENS`      | No                    | Output-token ceiling for each model round; defaults to 1,000, range 64–8,192.                            |
| `OPENROUTER_MAX_TOOL_ITERATIONS`    | No                    | Sequential read-only tool-call ceiling; defaults to 3, range 1–5.                                       |
| `OPENROUTER_REQUIRE_ZDR`            | No                    | Requests Zero Data Retention-compatible routing when `true`; use only with eligible configured models.  |
| `GEMINI_ENABLED`                     | No                    | Explicit opt-in for direct Gemini; defaults to `false`.                                                  |
| `GEMINI_API_KEY`                     | Yes, for Gemini       | Backend-only Google AI Studio API key. Store in a secret manager.                                        |
| `GEMINI_MODEL`                       | Yes, for Gemini       | Server-controlled direct Gemini model ID with function calling.                                         |
| `GEMINI_TIMEOUT_MS`                  | No                    | Direct Gemini call timeout; defaults to 30 seconds, range 5–120 seconds.                                |
| `GEMINI_MAX_OUTPUT_TOKENS`           | No                    | Direct Gemini completion ceiling; defaults to 2,048, range 64–8,192.                                    |
| `AI_MAX_MESSAGE_CHARS`              | No                    | Maximum user message length; defaults to 8,000.                                                          |
| `AI_MAX_HISTORY_MESSAGES`           | No                    | Recent persisted messages eligible for one context; defaults to 20.                                     |
| `AI_MAX_CONTEXT_CHARS`              | No                    | Character ceiling for persisted history supplied to a request; defaults to 40,000.                      |
| `AI_MAX_CONVERSATION_MESSAGES`      | No                    | Stored user-visible messages per conversation; defaults to 100.                                         |
| `AI_MAX_CONVERSATIONS_PER_USER`     | No                    | Stored conversations per tenant user; defaults to 100.                                                  |
| `AI_RATE_LIMIT_PER_MINUTE`          | No                    | AI chat requests per authenticated company/user tracker; defaults to 10.                                 |

OpenRouter and its selected downstream provider receive each submitted prompt, bounded user-visible conversation context, the system instruction and, when needed, minimized read-only tool results. When direct Gemini is used, Google receives that same necessary context. Gemini is accessed through Google's officially supported OpenAI-compatible endpoint using the existing OpenAI SDK; this preserves tool-call history, including opaque Gemini thought signatures, without sending requests through OpenRouter. The backend never enables Google Search or other provider-hosted tools. `gemini-3.5-flash-lite` is a current, tool-capable, low-latency/cost starting point; availability, quota and free-tier eligibility depend on the Google project. The free tier may permit provider data use, so review Google AI Studio billing and data-use settings before enabling it with production tenant data. Do not promise zero retention unless every selected provider's policy and configuration have been verified. Review provider terms, budgets, model allowlists and privacy policy before enabling production traffic. Provider/model and token counts are recorded internally; Gemini cost remains unknown unless Google reliably reports it (no price is fabricated). The API response shape is unchanged.

For local testing, put `GEMINI_ENABLED=true`, `GEMINI_MODEL=gemini-3.5-flash-lite`, and your private `GEMINI_API_KEY` only in the ignored local `.env`; keep the existing `OPENROUTER_*` values to test primary-first routing. For Render, add the same names in the service's private environment settings, keep `OPENROUTER_ENABLED=true` for primary routing, and redeploy after reviewing Google project quotas, billing and data-use policy. Keep the key out of `NEXT_PUBLIC_*` variables and never add it to Swagger or frontend requests. Set `GEMINI_ENABLED=false` to restore OpenRouter-only operation. If both provider flags are false, `/ai/chat` returns the existing `ai_disabled` response.

## Health and process lifecycle

- `GET /health/live` reports process liveness without contacting dependencies.
- `GET /health/ready` pings MongoDB and returns HTTP 503 with a sanitized response while MongoDB is unavailable.
- Nest shutdown hooks close managed resources on termination signals.
- Health routes reveal no credentials, hosts, stack traces, or application data.

Application logging does not log Stripe secrets or full provider errors/webhook payloads, request bodies, passwords, JWTs, raw verification/invitation tokens, SMTP credentials, AWS credentials, or uploaded file buffers. Infrastructure adapters emit only generic failure messages; client-facing dependency failures are sanitized.

## Production build and start

For a direct Node deployment:

```bash
npm ci
npm run build
npm run start:prod
```

`start:prod` executes `node dist/main`. The included multi-stage Dockerfile installs from the lockfile, builds the application, prunes development dependencies, and runs as the unprivileged `node` user:

```bash
docker build -t datavault-saas .
docker run --env-file .env -p 3000:3000 datavault-saas
```

The image contains no `.env`, source tests, Git metadata, or development dependencies.

Deployment checklist:

1. Provision an Atlas/replica-set database and allow the runtime network and database identity.
2. Supply secrets and configuration through the provider's secret/environment facility.
3. Configure explicit HTTPS CORS and activation/invitation frontend URLs.
4. Attach a least-privilege S3 role and verify private upload, download, deletion, and failed-upload cleanup.
5. Verify SMTP TLS, sender identity, activation delivery, and invitation delivery.
6. Configure the platform health checks: liveness for process restart decisions and readiness for traffic routing.
7. Confirm proxy hops, request-size limits, runtime memory, Mongo pool totals, and graceful termination timeouts.
8. Run `npm ci`, build, tests, and `npm audit` from the exact revision being deployed.

## Tenant model

A company stores its required name, uppercase ISO 3166-1 alpha-2 country, normalized industry, and activation timestamp. Company names are case-insensitively unique. The registration email and password belong to the owner User and are not duplicated on Company. Every user has one required, immutable `companyId` and one role: `company_owner` or `company_member`. User emails remain globally unique so authentication resolves one identity without requiring a tenant hint.

Email sign-up atomically creates an inactive company, its owner, its Free subscription, and a hashed 24-hour activation token. The raw token is sent by SMTP after commit and is never stored. Password and Google sign-in are rejected until activation. Google sign-up uses Google's verified email and creates an immediately activated company after the owner supplies company details. The authentication guard reloads activation state on every protected request. Activated company owners invite employees by email; the 72-hour, single-use invitation is the only path that creates a `company_member`. Acceptance derives the company, email, and role from the stored invitation. Members can read and update only themselves. Only owners may list or delete employees, manage invitations, or invite employees. Owners cannot delete themselves. User email, company, and role are immutable through profile updates because email-change verification and ownership transfer do not exist.

Authenticated owners and employees change their own password through `PATCH /users/me/password`. The endpoint verifies the existing password, requires a different 12–72 character replacement with uppercase and lowercase letters, a number, and a symbol (at most 72 UTF-8 bytes), hashes it with bcrypt, and uses the previous hash as an atomic update condition. Generic user profile updates accept only `fullName`; password and identity fields are rejected by request validation.

JWTs contain only the user id. Authentication reloads the user on every request and derives current company and role data from MongoDB. Tenant-owned queries also include `companyId`, preventing cross-company access even when a target id is known.

## Plans and subscriptions

The code-defined plan catalog is the source of truth and is idempotently synchronized to MongoDB on startup. Free includes space for 10 currently stored files and the owner only; deleting a file frees a slot for a replacement. Basic includes 100 currently stored files, up to 10 employees plus the owner, and costs $5 per employee per month. Premium includes 1,000 currently stored files, unlimited employees, costs $300 per month, and records $0.50 per successful upload above its stored-file allowance. Deleting a file frees an included slot on every plan; past upload records and overage charges are retained.

Each company has one subscription. With `STRIPE_ENABLED=false`, plan changes take effect immediately, preserve the original activation/billing anchor, and do not reset the current period's usage. A downgrade is rejected when stored files or accepted employees plus live pending invitations exceed the target plan. Owners can choose what to remove themselves, or explicitly confirm automatic cleanup before retrying the downgrade. Automatic cleanup keeps the newest allowed files and oldest accepted employee accounts, then retains oldest pending invitations within remaining seat capacity. It deletes older excess files and newest excess employee accounts and revokes excess pending invitations; the owner account is retained. Assignment mode requires no payments or provider states. Stripe-managed subscriptions follow the additional lifecycle below; disabling Stripe never silently bypasses their payment gate.

`GET /subscriptions/current/billing` returns an internal current-period estimate in integer USD cents. The response derives every value server-side from the authenticated company: the code-defined current plan supplies its base price, employee unit price, included upload allowance, and Premium overage unit price; the user collection supplies the current accepted employee count (the owner and pending invitations are not billed); and the current `SubscriptionPeriod` supplies successful uploads and overage already recorded when Premium uploads succeeded. The total is `baseAmountCents + employeeChargeCents + overageChargeCents`.

The estimate uses the current plan and current employee count because the assignment defines neither proration nor historical employee/plan charging rules. It is always labeled `current_plan_estimate_with_recorded_overage`, includes `planChangedInCurrentPeriod`, and is not an invoice or payment state. An immediate plan change retains the activation-day anchor and accumulated upload usage. Recorded Premium overage remains in the period after a downgrade, while the new plan controls future entitlements. Historical uploads may exceed the new stored-file allowance; capacity depends only on files still stored. Period ends are exclusive, and day-29/30/31 anchors clamp to the last UTC day of short months before returning to the original day when possible.

`EntitlementsService` is the internal boundary for employee and file limits. Invitation creation reserves a seat, and acceptance converts that reservation into an employee in a transaction. Free permits no employees, Basic permits 10 employees plus the owner, and Premium has no employee limit. Successful file uploads record metadata and monthly usage in the same transaction; deletion preserves historical upload counts but frees a stored-file slot on every plan.

Owners can request `POST /subscriptions/downgrade-preview` with `{ "planCode": "free" }` (or Basic) to see exact cleanup counts and a workspace fingerprint. `POST /subscriptions/downgrade-cleanup` requires that plan and its `previewToken`; a changed preview is rejected before starting. Cleanup is permanent and precedes the ordinary plan request. Storage and Stripe cannot be rolled back with MongoDB: a failed cleanup or billing request may leave some confirmed deletions completed. Refresh and review a new preview before retrying. Upgrading later does not restore removed files or employee accounts. Direct plan changes retain their manual capacity checks and never delete anything.

## Bonus: company statistics dashboard

`GET /statistics/current` is an additional read-only dashboard endpoint beyond the original assignment requirements. Activated owners and members receive statistics only for the company derived from their JWT. The response combines accepted employees, live pending invitations, current file-metadata counts by visibility, activation-anchored upload usage, current plan capacity, Premium overage, and the existing integer-cent billing calculation. It accepts no calculation or tenant inputs and sends `Cache-Control: private, no-store`.

Currently stored files and current-period successful uploads are separate values: deleting a file removes its metadata from the stored count but does not reduce historical monthly upload usage. `remainingUploads` counts available stored-file slots for Free and Basic, and is `null` for Premium, where uploads beyond the included 1,000 are billed as overage. Employee limits use the same convention: `null` means unlimited.

## DataVault AI Assistant (OpenRouter)

The optional `src/ai` module provides a general conversational assistant for activated tenant owners and members. Ordinary programming, writing, explanation, brainstorming and business questions go through the configured language model. DataVault account questions use a bounded server-side tool loop so account facts come from existing authoritative services.

### API and conversation lifecycle

All routes require a tenant JWT, reject platform-admin JWTs, return `Cache-Control: private, no-store`, and derive company/user ownership from the authenticated request:

| Endpoint                       | Input/behavior                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /ai/chat`                | `{ "message": "…", "conversationId"?: "…" }`; creates a conversation when the ID is omitted or appends one user/assistant exchange to the caller's conversation. |
| `GET /ai/conversations`        | Lists only the caller's conversations with bounded `page`/`limit`; content is not duplicated in list results.                                                         |
| `GET /ai/conversations/:id`    | Returns the caller's conversation and its user-visible user/assistant messages in order.                                                                               |
| `DELETE /ai/conversations/:id` | Hard-deletes the caller's conversation and message content. Content-free usage records remain for aggregate cost/operations reporting.                                 |

Conversation, message and usage documents carry immutable `companyId` and `userId` references. Every lookup and mutation includes both references; another user in the same company and every other tenant receive the same non-enumerating 404. One expiring database lease serializes requests for a conversation. The final exchange and usage record commit together in a MongoDB transaction, with a unique server-generated request ID supporting safe uncertain-commit recovery. History is bounded by message and character limits, each conversation has a stored-message ceiling, and user conversation counts are bounded.

The usage collection stores only model names, input/output/total tokens, duration, tool-call count and provider cost converted to integer micro-USD when OpenRouter reliably returns it. Values come only from provider responses and server timing. It does not copy prompts, completions or tool results. AI usage is operational metadata only; it does not change DataVault plans, Stripe billing, employee seats, file quotas, or the assignment billing estimate.

### Read-only DataVault tools

The model can request exactly these tools:

- `get_company_profile` — safe company name, country, industry, activation date and caller role.
- `get_subscription_and_billing` — current plan/entitlements, activation-anchored period, accepted employee count and existing DataVault billing estimate.
- `get_company_statistics` — the existing tenant dashboard composition for employees, pending invitations, stored files, upload usage and limits.
- `list_visible_files` — up to 10 recent metadata records after the existing owner/member/uploader/restricted-file authorization rules; no storage key, internal IDs, URL, credentials or file content.

Tool arguments are strict JSON and never accept tenant/user IDs. Unknown or repeated calls, oversized arguments and iteration overflow fail closed. The model proposes calls but never authorizes them: tool services receive the current server-authenticated actor and reuse existing tenant-aware services. Tools cannot write data, access platform administration, query arbitrary MongoDB data, run code/shell commands, fetch URLs, inspect S3 objects, call Stripe, or expose private spreadsheet/CSV contents.

The system instruction treats prompts and tool data as untrusted and forbids disclosure of hidden instructions, schemas, raw tool payloads, credentials, internal identifiers and other tenants. Technical isolation does not depend on the model following that instruction. Request logs contain a random correlation ID and safe usage/timing fields, never prompt/completion/tool content or provider credentials. Provider authentication, credit, rate-limit, timeout, malformed-response and 5xx failures map to sanitized application errors.

This first version returns an atomic JSON response. SSE streaming is intentionally deferred: persisting one complete exchange, applying tool limits and returning one safe provider error are more reliable than exposing partial output before the transaction commits. The controller/client boundary and model client interface leave a clean extension point for a separately designed streaming protocol.

Automated tests replace the model client and make no OpenRouter or Gemini calls. For one deliberate local provider test after adding your own key:

1. In OpenRouter, create a restricted development key with a small credit/budget limit. Review the selected models' tool support and provider privacy/retention policy; configure account model/provider allowlists as needed.
2. Put the key only in the ignored local `.env`. Set `OPENROUTER_ENABLED=true`, `OPENROUTER_API_KEY`, a tool-capable `OPENROUTER_MODEL`, and optional tool-capable fallbacks. Keep output, timeout and iteration limits small. Set `OPENROUTER_REQUIRE_ZDR=true` only after confirming eligible routing.
3. Build and start the backend. Sign in as an activated disposable test-tenant user through your local API client. Keep the tenant JWT in that client's private authorization store rather than source, shell history or saved shared requests.
4. Send `POST /ai/chat` with `{ "message": "Explain dependency injection in one paragraph." }`. Confirm a normal answer, bounded server-reported usage and no secret/provider details in the response or logs.
5. Reuse the returned conversation ID with a follow-up, then ask a DataVault question such as `What is my current file allowance?` to exercise an authoritative tool. Do not include secrets or private file contents in prompts.
6. Retrieve and delete the disposable conversation through the routes above. Set `OPENROUTER_ENABLED=false`, restart, and revoke the temporary key when testing is complete.

## Private company files

Configure `AWS_BUCKET_NAME` and `AWS_REGION` to enable file operations. Use a private bucket with S3 Block Public Access enabled and an IAM role allowing only the required `PutObject`, `GetObject`, and `DeleteObject` operations. Explicit access-key credentials are optional; the SDK's default credential chain supports deployment IAM roles. Unconfigured storage returns HTTP 503. The previous public CloudFront URL helper has been removed.

Uploads use a multipart `file` field, optional `visibility` (`company_wide` by default or `restricted`), and optional `restrictedUserIds`. A single employee id may be sent directly; multiple ids use one JSON-array field. Other form fields are rejected. Ownership, uploader, and `companies/<companyId>/files/<random UUID>.<extension>` keys are generated by the server. MongoDB stores metadata only. `FILE_MAX_SIZE_BYTES` defaults to 10 MiB and is capped at 100 MiB because uploads are buffered in memory. Align reverse-proxy request limits and deployment capacity with this value.

Validation requires a supported extension, compatible declared MIME type, and content structure. CSV must be non-empty UTF-8 text without binary control characters; common CSV/text MIME aliases are supported. XLS must have an OLE compound header and workbook stream marker. XLSX must have a valid ZIP central directory containing `[Content_Types].xml` and `xl/workbook.xml`. This validates format structure without importing spreadsheet-processing logic.

Every file is either company-wide or restricted. Activated members see company-wide files plus restricted files that explicitly contain their user id; uploaders retain access to and control of their own files, and the company owner sees and manages every tenant file. Restricted ids are validated as unique, existing `company_member` users in the authenticated company. Company-wide files have an empty restricted list, while restricted files require at least one selected employee. Existing records without a visibility field are treated as company-wide for backward compatibility.

The uploader or company owner may replace a file's visibility and complete restricted list. This updates MongoDB authorization metadata only; it never copies the object or changes a private S3 ACL. Cross-company and unauthorized metadata/download identifiers return HTTP 404. A same-company non-uploader receives HTTP 403 when attempting permission changes. Downloads stream through the authenticated backend with attachment headers, MIME sniffing disabled, and private/no-store cache policy. No public or presigned S3 URL is exposed, so there is no reusable download-link expiration to manage.

Employee deletion uses lazy permission cleanup. A deleted user's id may remain in historical restricted lists, but authentication reloads users on every request, so the deleted identity immediately loses access and the stale id cannot authorize anyone else. Owners retain access and can replace the permission list. This avoids coupling employee deletion to a potentially large file update and keeps deletion independent of S3.

An advisory quota check avoids unnecessary S3 uploads when the company is already at its limit. After S3 succeeds, an authoritative quota update selects the billing period at transaction time, acquires the existing subscription lock, and commits with metadata using majority write concern. Concurrent uploads cannot exceed Free/Basic limits, and Premium overage is recorded in cents. A known-failed transaction triggers S3 cleanup. If MongoDB reports an uncertain commit acknowledgement, a primary/majority metadata read first confirms whether the transaction committed; a confirmed commit is returned successfully, while an inconclusive or failed read leaves the private object intact rather than risking deletion of a committed file. No external S3 call occurs inside a retryable MongoDB transaction. A process crash between S3 upload and database commit, an uncertain commit, or a failed compensating delete can leave a private orphan object; reconciliation remains an operational follow-up. If S3 deletion succeeds but the subsequent metadata deletion fails, the metadata can temporarily point to a missing object and also requires operational repair.

Deletion removes the S3 object first, then its tenant-scoped metadata. S3 failure preserves metadata. If the later database deletion fails, the metadata remains retryable because S3 object deletion is idempotent. Monthly usage is never decremented.

## Architecture

- `src/auth`: company onboarding, email/password and optional Google sign-in, and JWT issuance
- `src/email`: provider-neutral email contract, activation/invitation templates, and SMTP/Resend adapters
- `src/invitations`: tenant-bound employee invitation lifecycle and acceptance
- `src/companies`: company schema, current-company read/update routes, and validation
- `src/users`: tenant-scoped management of existing users
- `src/plans`: immutable plan definitions, persisted catalog schema, and public read route
- `src/subscriptions`: company subscription state, calendar billing periods, and centralized entitlement enforcement
- `src/subscriptions/billing.service.ts`: authoritative current-period billing estimate from plan, employees, and upload accounting
- `src/common`: current-user context plus extensible role metadata and guard
- `src/files`: tenant-owned metadata, multipart validation, upload compensation, private downloads, and deletion policy
- `src/aws-s3`: provider-neutral object-storage contract and private S3 adapter
- `src/config`: startup validation and shared HTTP configuration
- `src/health`: public liveness/readiness probes and MongoDB transaction-capability startup check
- `src/statistics`: bonus tenant dashboard composed from existing authoritative domain data
- `src/ai`: tenant-owned conversations, OpenRouter adapter, safe usage accounting, throttling, and read-only DataVault tool loop

## Commands

```bash
npm run build
npm run lint
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run start:prod
```

## Current API

- `GET /health/live` — process liveness
- `GET /health/ready` — MongoDB readiness
- `POST /auth/sign-up` — creates a pending company, optional owner profile, Free subscription, and activation token; requires `companyName`, `email`, `password`, `country`, and `industry`
- `POST /auth/verify-account` — consumes a single-use activation token
- `POST /auth/resend-verification` — generic, cooldown-protected resend response
- `POST /auth/sign-in`
- `GET /auth/current-user` — authenticated
- `GET /auth/google` and `GET /auth/google/callback` — optional browser-bound Google authentication; callback redirects existing users to sign-in and new users to registration
- `POST /auth/google/exchange` — atomically consumes the code and returns a tenant JWT
- `POST /auth/google/register` — completes Google registration with company details and returns a tenant JWT
- `GET /companies/current` — any company user
- `PATCH /companies/current` — company owner
- `POST /invitations` — activated company owner invites an employee; accepts only an email
- `GET /invitations` — company owner lists their company's live pending invitations
- `POST /invitations/:id/resend` — company owner rotates and resends a live invitation after the cooldown
- `DELETE /invitations/:id` — company owner revokes a pending invitation
- `POST /invitations/accept` — public employee acceptance with token, full name, and password
- `GET /users` — company owner lists users in their company
- `GET /users/:id` — self or company owner, within the company
- `PATCH /users/me/password` — authenticated self-service password change requiring `currentPassword` and `newPassword`
- `PATCH /users/:id` — self or company owner, within the company; accepts only `fullName`
- `DELETE /users/:id` — company owner deletes a member; owner self-deletion is rejected
- `GET /plans` — public plan catalog
- `GET /subscriptions/current` — any authenticated company user
- `GET /subscriptions/current/billing` — owner/member internal current-period estimate; no calculation inputs
- `PATCH /subscriptions/current` — company owner changes the company plan
- `POST /files` — authenticated multipart upload with `file`, optional `visibility`, and optional `restrictedUserIds`
- `GET /files` — company file list using `page` and `take`, capped at 30 per page
- `GET /files/:id` — company file metadata
- `GET /files/:id/download` — authenticated private attachment stream
- `PATCH /files/:id/permissions` — uploader or company owner replaces visibility and restricted employees
- `DELETE /files/:id` — uploader or company owner deletes a company file
- `GET /statistics/current` — activated owner/member tenant dashboard; accepts no client-supplied statistics
- `POST /ai/chat` — activated owner/member general AI chat with optional owned `conversationId`
- `GET /ai/conversations` — caller-owned paginated conversation list
- `GET /ai/conversations/:id` — caller-owned conversation and user-visible history
- `DELETE /ai/conversations/:id` — hard-delete caller-owned conversation content

## Optional Stripe Test Mode payments

This integration is additional functionality. `STRIPE_ENABLED=false` is the default and preserves the original assignment flow and internal billing calculations. It never uses live keys or live catalog objects. SDK `stripe@22.6.2` and API `2026-08-26.dahlia` are pinned. No card number, CVC, payment-method detail, secret, or complete webhook payload is stored in MongoDB.

### Authority and catalog setup

DataVault owns tenant identity, owner/member permissions, activation, accepted employees, pending-seat reservations, successful upload counts, product limits, and the immutable original subscription anniversary. Stripe owns card setup, collection, its subscription lifecycle, and real invoice/payment results. `GET /subscriptions/current/billing` and dashboard billing remain **DataVault current-plan estimates**, not Stripe invoices or amounts collected. `GET /payments/current` returns actual Stripe invoice amounts separately, in integer USD cents.

Create the following **Test Mode** catalog in Stripe before enabling the integration. Do not create a Free Stripe subscription.

| Mapping                   | Stripe configuration                                                                            | DataVault rule                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `STRIPE_BASIC_PRICE_ID`   | USD 500 cents, monthly, per-unit, licensed recurring Price                                      | Quantity = accepted `company_member` users, 0–10. Owner and pending invitations are excluded from charges. |
| `STRIPE_PREMIUM_PRICE_ID` | USD 30000 cents, monthly, per-unit, licensed recurring Price                                    | Quantity = 1. Unlimited employees.                                                                         |
| `STRIPE_OVERAGE_PRICE_ID` | USD 50 cents, monthly, per-unit, metered recurring Price linked to the configured billing meter | Only incremental successful Premium uploads beyond DataVault's 1,000-stored-file allowance are reported. |

Create an active billing meter with **sum** aggregation, the event name in `STRIPE_OVERAGE_EVENT_NAME`, customer mapping payload key `stripe_customer_id`, and numeric value key `value`. Set `STRIPE_OVERAGE_METER_ID` to that meter. Do not configure an additional free tier on the meter: DataVault already excludes included uploads. Leave tax, discounts, trials, usage thresholds, and invoice credits unconfigured for this product; these are outside the implemented policy. The server checks all three prices and meter settings before Checkout and paid plan changes, including rejection of quantity transforms that would change per-unit billing.

Create a Test Mode Customer Portal configuration. Enable payment-method updates and invoice history/payment access. **Disable subscription updates and cancellation** in the portal: those must go through DataVault's seat/upload conflict checks. The server rejects a configuration with those controls enabled. Do not modify DataVault subscriptions, catalog quantities, schedules, or billing anchors directly through Stripe Dashboard; such changes are detected/reconciled rather than accepted as client product rules.

| Variable                                                                                | Required when enabled | Purpose                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STRIPE_ENABLED`                                                                        | No                    | Opt-in boolean, defaults to `false`.                                                                                                                                                       |
| `STRIPE_SECRET_KEY`                                                                     | Yes                   | Test secret key (`sk_test_…`), backend/secret manager only.                                                                                                                                |
| `STRIPE_WEBHOOK_SECRET`                                                                 | Yes                   | Endpoint signing secret (`whsec_…`); local CLI and deployed endpoint secrets differ.                                                                                                       |
| `STRIPE_BASIC_PRICE_ID`, `STRIPE_PREMIUM_PRICE_ID`, `STRIPE_OVERAGE_PRICE_ID`           | Yes                   | Three distinct Test Mode Prices with the exact configurations above.                                                                                                                       |
| `STRIPE_OVERAGE_METER_ID`, `STRIPE_OVERAGE_EVENT_NAME`                                  | Yes                   | Sum meter and its event name.                                                                                                                                                              |
| `STRIPE_PORTAL_CONFIGURATION_ID`                                                        | Yes                   | Test Mode portal configuration without plan/cancel controls.                                                                                                                               |
| `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL`, `STRIPE_PORTAL_RETURN_URL` | Yes                   | Server-configured frontend destinations. HTTPS outside localhost; HTTPS everywhere in production. No URLs are accepted from the client.                                                    |
| `STRIPE_SYNC_INTERVAL_MS`                                                               | No                    | Mongo-backed reconciliation polling, defaults to 30 seconds (10–300 seconds). Run at least one long-lived Nest process; serverless-only request execution cannot run this worker reliably. |

These settings are placeholders in `.env.example`; configure actual values privately. Test Mode keys/prices/meter/portal must belong to the same Stripe account/environment.

### API and hosted setup flow

All six authenticated endpoints require an activated company and `company_owner`; members cannot inspect or control payment-provider data. No endpoint accepts tenant IDs, quantities, prices, amounts, usage, or redirect URLs.

| Endpoint                   | Input                                              | Result                                                                                                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /payments/checkout`  | `{ "planCode": "basic" }` or `premium`             | Hosted Checkout setup URL; `mode: "setup"`, `paymentCollected: false`.                                                                                                                                                                                             |
| `POST /payments/portal`    | Empty body                                         | Short-lived hosted portal URL for the authenticated company.                                                                                                                                                                                                       |
| `GET /payments/current`    | No inputs                                          | Test Mode, local plan/access, Stripe status, queued target/date, billing period, sync issue/time/pending usage, and the latest 10 tenant Stripe invoices (IDs, status, currency, amounts in cents, hosted URL, creation date). `Cache-Control: private, no-store`. |
| `POST /payments/plan`      | `{ "planCode": "basic" }` (Free, Basic or Premium) | Validated immediate upgrade or downgrade to Free; Premium→Basic is queued. Choosing the current plan undoes a queued change.                                                                                                                                                 |
| `POST /payments/cancel`    | Empty body                                         | Validated immediate downgrade to Free; no automatic refund.                                                                                                                                                                                                               |
| `POST /payments/reconcile` | Empty body                                         | Owner-requested recovery/synchronization followed by current payment information; limited to 5 requests/minute.                                                                                                                                                    |
| `POST /payments/webhook`   | Stripe-signed raw JSON                             | Public signature-verified webhook, independent of JWT/CORS browser authorization.                                                                                                                                                                                  |

When enabled, the existing owner-only `PATCH /subscriptions/current` delegates to the same payment plan service; it cannot grant paid access directly. An unmanaged paid plan from assignment mode must complete Checkout before new uploads/onboarding when payments are enabled. Existing data remains readable and deletable.

Checkout uses **setup mode**, not a payment assertion. A signed completion event or reconciliation retrieves the canonical completed Checkout and succeeded SetupIntent, verifies the stored company/customer/session/operation mapping, and creates the recurring subscription server-side using the saved card. A redirect or frontend claim never activates anything. A company Stripe Customer is created lazily using a stable tenant idempotency key. Basic supports zero accepted employees and hence a zero-quantity item. There is no invented trial period.

### Anniversary, charges and plan changes

The original UTC activation day/hour/minute/second becomes Stripe's `billing_cycle_anchor_config`; day 29/30/31 clamps in short months and returns to the original day. Stripe has second precision; DataVault retains its original millisecond precision and quota periods. Both configuration and returned subscription item period ends are validated against DataVault's anniversary. No action resets accumulated uploads or the anniversary.

**Proration is disabled everywhere.** Card setup does not charge. The initial partial period's recurring Basic/Premium fee is deferred/waived by Stripe's `proration_behavior: none`, with the first full recurring fee collected at the next anniversary. There is no fake paid state, backdated invoice, activation charge, or fractional-month formula. Premium overage still comes only from recorded successful uploads. An immediate Basic→Premium upgrade changes entitlements after a trusted Stripe update; the changed recurring price applies at the next anniversary. Previously collected invoices are not rewritten/refunded. This explicit policy differs from the current-plan estimate during partial periods.

Premium→Basic uses a Stripe subscription schedule at the current period end, preserving the original anchor with no phase proration. Basic/Premium→Free cancels immediately after Stripe confirmation, with no final invoice or prorated refund. Downgrades/cancellations are rejected if accepted employees plus live pending invitations exceed the target or stored files exceed the target plan’s capped allowance. While a lower plan is queued, onboarding/uploads enforce the stricter current/target capacity, preventing concurrent requests from invalidating the downgrade. The owner can delete extra files/employees or revoke invitations before retrying any downgrade. Free replaces any queued paid-plan change. Other conflicting queued targets are rejected; choosing the current plan first removes the pending request. An unconfirmed Premium→Basic downgrade that misses its anniversary is flagged for reconciliation instead of silently moving to a later date; choosing the current plan resets that request so the owner can explicitly choose a new date. External cancellation with a Free conflict suspends mutations and preserves the prior plan/data until Free can fit.

Local access states are `unmanaged` (assignment mode), `deferred` (Stripe-confirmed active subscription before collection/during a draft), `active` (active with a paid latest invoice, or a valid post-cancellation Free company), and `suspended` (incomplete, past-due, unpaid, paused, canceled with conflicts, or an open/action-required/uncollectible invoice). Deferred never means paid. Recovery from canonical active/paid Stripe state restores access. Suspended companies retain authentication, reads/downloads/deletions and owner remediation, but cannot upload or onboard employees. A `reconciliation_required` issue blocks new uploads/onboarding until resolved. Managed payment state older than 24 hours fails closed for these mutations; disabling the integration also fails closed for managed companies.

### Employees, overage, reconciliation and retries

Basic quantities come only from accepted tenant employees. Acceptance and, in Stripe mode, deletion share the subscription transaction lock with plan changes and authoritative seat snapshots. The durable reconciliation worker converges the licensed item without proration; invitation creation reserves capacity but does not increase Stripe quantity. At renewal, invoice reconciliation saves one accepted-employee snapshot in Stripe invoice metadata and adjusts the draft Basic line to it before collection. Changes after that snapshot affect the next renewal; the DataVault estimate always uses the live count.

Usage recorded before opting into Stripe is not back-charged or backfilled. Existing counters/estimates remain intact; new managed successful uploads produce the durable reporting records.

A successful Premium overage upload creates a unique `StripeUsage` outbox row **inside the same MongoDB transaction** as file metadata and period usage. Failed storage/database work cannot enqueue charges; deletion never removes usage or outbox rows. Rows contain company/customer/subscription identifiers, integer quantity, period, reporting timestamp, stable event identifier, delivery state and retry timestamps. The worker submits sum-meter events using that identifier and the same Stripe idempotency key, then marks them submitted. It never reports client counts or all 1,000 included uploads.

Stripe meter summaries are minute-aligned and asynchronous. Reporting timestamps move by less than a minute at interval boundaries so each event belongs to the correct company/Stripe meter window, including immediately after Premium activation. DataVault timestamps/quota boundaries are unchanged. Draft invoices are held with `auto_advance: false` until local pending usage is delivered and the Stripe meter summary equals the authoritative outbox quantity; a verified matching summary supplies the draft overage line quantity. Only then is automatic collection restored. Mismatches are exposed as `reconciliation_required`, never silently replaced with an invented total. Unrelated/manual customer invoices are not modified. An invoice already finalized during a prolonged outage cannot be rewritten by this integration; inspect it manually against the outbox before collecting/correcting it.

Supported webhook events: `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.created`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, and `invoice.marked_uncollectible`. Other events are acknowledged and ignored. Live events and invalid/missing signatures are rejected. Webhooks always retrieve current canonical Stripe state instead of applying possibly stale event snapshots. A durable unique `StripeEvent.eventId` ledger is committed with local state in a MongoDB transaction; duplicate/replayed events cannot double-apply it. Ledger entries deliberately have no TTL. Stripe event/outbox model initialization awaits their required indexes before serving traffic; unique partial customer/subscription/Checkout indexes protect company mappings. Unknown external objects are ignored; events racing a known Checkout subscription creation are retried. Operational failures return sanitized HTTP 503 so Stripe retries.

Per-company Mongo leases serialize Stripe operations across process replicas; subscription transaction revision locks serialize local seats/usage/plan constraints. Stripe calls occur outside Mongo transactions and use stable keys and persisted operation snapshots. The worker claims due tenants in bounded batches and retries failures without starving other companies. It resumes from persisted state after restart; manual owner reconciliation uses the same path. Deploy a long-lived process and allow time for graceful shutdown.

Stripe's meter identifier and general idempotency windows are finite. An ambiguous operation older than **23 hours**, or usage too old for Stripe's 35-day reporting window, is frozen for manual reconciliation rather than blindly resubmitted and potentially charged twice. Inspect Test Mode resources/event logs against the stored operation/outbox before repairing synchronization state; do not delete the ledger or fabricate payment records. The endpoint exposes pending usage and synchronization issues. Monitor worker warnings and Stripe webhook delivery failures; durable ledgers do not replace operational alerting.

### Local testing and deployment

Use Stripe's official CLI and a **Test Mode** account. Configure Test products/prices/meter/portal privately, set `STRIPE_ENABLED=true`, start Nest, and forward signed events:

```bash
stripe listen --forward-to localhost:3000/payments/webhook
```

Put the CLI's signing secret into the private local environment and restart; never paste it into source, logs or issue reports. For deployment register `https://YOUR_API_DOMAIN/payments/webhook` with the supported event list and API `2026-08-26.dahlia`, and use **that endpoint's** Test Mode signing secret. Nest enables `rawBody: true` so cryptographic verification receives unmodified bytes; Helmet, CORS, strict DTO validation and the normal JSON size limit remain enabled for all other routes. Do not install middleware that parses/reformats the webhook body before Nest captures it.

Register and activate a company, sign in as owner, request Checkout and open its returned URL. Use Stripe's documented Test card `4242 4242 4242 4242` with a future expiry and test CVC in **Stripe's hosted page only**. Return to the frontend and poll `/payments/current`; never use the redirect as payment proof. Confirm webhook retries, subscription creation, original anchor, zero/nonzero Basic seats, Premium meter events and draft reconciliation in Test Mode. The automated suite uses controlled dates for leap years and month-end anchors and mocks all Stripe APIs without external calls. For provider-level renewal tests use actual Test Mode anniversaries or isolated Stripe Test Clock fixture customers with a matching controlled backend clock and disposable database; the normal API never accepts a frontend test-clock ID. Verify failure/recovery, month-end downgrade/cancellation and invoice totals in that isolated environment. Run provider-level tests before declaring the integration deployment-ready.

Relevant official references: [hosted card setup](https://docs.stripe.com/payments/save-and-reuse-cards-only), [billing-cycle anchors and no-proration behavior](https://docs.stripe.com/billing/subscriptions/billing-cycle), [meter event recording and limits](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api), and [draft invoice line updates](https://docs.stripe.com/api/invoices/update_line). Live payments, tax, refunds, arbitrary portal plan changes, trial campaigns, and a historical local invoice database are outside this Test Mode feature.

## DataVault platform administration

A **platform administrator** is a separate identity in `platformadmins`, with no company membership. A `company_owner` administers only their own tenant and cannot access `/admin`. Platform tokens cannot authenticate to tenant endpoints, including file downloads. There is no public platform registration, impersonation, company deletion, administrator-to-administrator password editing, quota editing, or provider-state editing API.

### Bootstrap and authentication

Build first and run the explicit bootstrap command against the intended MongoDB replica set. Supply these CLI-only variables privately through an environment/secret manager or the local ignored `.env`; never put credential values into shell history or source:

| Variable                             | Purpose                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `MONGO_URI`                          | Intended transactional MongoDB database.                                                                                      |
| `PLATFORM_ADMIN_BOOTSTRAP_EMAIL`     | Explicit administrator email; normalized to lowercase.                                                                        |
| `PLATFORM_ADMIN_BOOTSTRAP_FULL_NAME` | Explicit display name, 2–100 characters.                                                                                      |
| `PLATFORM_ADMIN_BOOTSTRAP_PASSWORD`  | At least 12 characters, at most 72 UTF-8 bytes; uppercase, lowercase, digit and non-whitespace special character. No default. |

```bash
npm run build
npm run admin:bootstrap
```

Bootstrap starts only an isolated database application context, without HTTP, SMTP, S3 or payment workers. It awaits indexes and creates the bcrypt cost-12 password hash and bootstrap audit entry transactionally. Repeating the command for an existing email leaves credentials unchanged; it does not reset passwords or reactivate disabled administrator identities. Creating another explicit email is also a privileged CLI operation. Remove bootstrap credentials from runtime configuration after use. Command output never contains identity or credential values.

An active platform administrator can select **Forgot admin password?** on `/admin`. The API emails a one-time reset link to the account's email through the configured SMTP or Resend sender. The link points to `/admin` on the `ACCOUNT_ACTIVATION_URL` origin, expires after 30 minutes, and can be used once. A new password must meet the bootstrap policy. Resetting invalidates earlier platform sessions. The request response does not reveal whether the email belongs to an administrator. Verify that the activation URL's origin is the frontend serving `/admin`.

If email recovery is unavailable, build and run the dedicated interactive maintenance command:

```bash
npm run build
npm run admin:reset-password -- --confirm-platform-admin-password-reset
```

The command requires the exact existing administrator email, a new password entered twice, and the exact email entered again, all through non-echoing TTY prompts. The new password uses the same 12-character/72-byte, uppercase, lowercase, digit and special-character policy and bcrypt cost 12 as bootstrap. It refuses unknown or inactive administrators and has no force/reactivation mode. One MongoDB transaction changes only that administrator's password and appends a `password_reset` audit event; no password or hash is stored in the audit record. It also invalidates earlier platform sessions and pending email reset links. It never starts HTTP or calls tenant, Stripe, S3 or SMTP services.

`POST /admin/auth/login` accepts `{ "email": "…", "password": "…" }` and returns `{ "accessToken": "…" }`. Login is limited to 5 requests/minute per IP with the existing in-memory throttler. Administrator JWTs last 30 minutes and use HS256 with explicit issuer, audience and token purpose. Their signing key is derived from `JWT_SECRET` using HKDF-SHA256 with a separate purpose; rotating `JWT_SECRET` invalidates both tenant and platform tokens. Every admin request checks the administrator's current `isActive` database state. Successful and credential-failed logins are audited; unknown accounts are recorded without submitted identity information. Authentication fails closed if audit persistence fails.

### API

All endpoints below require a platform token in `Authorization: Bearer …`, are limited to 60 requests/minute per IP, and return `Cache-Control: private, no-store`:

| Endpoint                               | Behavior                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/dashboard`                 | Global company activation/suspension/plan counts, owner/member counts, live pending invitations, stored file/visibility counts, sum of current company-period upload counters, and local Stripe-managed/payment-attention counts when enabled. No provider calls.                   |
| `GET /admin/companies`                 | Company profiles with safe subscription synchronization metadata. Filters: `search` (company name), `activation=activated\|pending`, `status=active\|suspended`, `plan=free\|basic\|premium`, `paymentAccess`, `stripeManaged=true\|false`. Sort: `createdAt`, `name`, `updatedAt`. |
| `GET /admin/companies/:id`             | Profile/status history marker, safe owner identity, accepted employees/pending invitations, stored file counts, existing subscription/billing-period estimate, safe Stripe identifiers/status/synchronization metadata, and missing owner/subscription warnings.                    |
| `POST /admin/companies/:id/suspend`    | Body `{ "reason": "security_review" }`; allowed reasons: `security_review`, `policy_review`, `operational_hold`. Status and audit entry commit together.                                                                                                                            |
| `POST /admin/companies/:id/reactivate` | Empty body `{}`; records server-selected `review_completed` reason and audit entry.                                                                                                                                                                                                 |
| `GET /admin/users`                     | Safe tenant-user identity metadata only. Filters: `search` (email/name), `companyId`, `role`. Sort: `createdAt`, `email`, `fullName`.                                                                                                                                               |
| `GET /admin/files`                     | File metadata only. Filters: `search` (filename), `companyId`, `visibility`, `fileType`. Sort: `createdAt`, `originalFilename`, `size`. No storage keys, links or file contents.                                                                                                    |
| `GET /admin/audit-logs`                | Append-only security history. Filters: `action`, `actorId`, `targetId`; chronological sorting. No update/delete API.                                                                                                                                                                |

Lists return `{ "items": [], "pagination": { "page": 1, "limit": 25, "total": 0 } }`. Pagination is bounded to pages 1–1,000 and 1–100 items; `order=asc|desc` is allowlisted. Search is literal, case-insensitive, at most 80 characters; client regular expressions/operators and unknown DTO fields are rejected. List aggregation timeouts are 5 seconds, dashboard aggregation timeouts 10 seconds. Search may scan at large scale; assess actual query performance before increasing limits.

Dashboard counts are operational read-time observations, not one transactionally frozen global snapshot. Current-period totals sum recorded rows whose activation-anchored period contains the request time; companies without a period row have zero recorded usage. Stored file counts differ from historical successful uploads: deleting a file never refunds usage. Recorded overage and company billing estimates are **not collected revenue or Stripe invoices**. Payment-attention counts use existing local payment access, synchronization issue and 24-hour freshness policy; no live Stripe calls are made for dashboard/detail reads.

### Suspension and audit policy

Platform status is independent of email activation and payment access. Legacy companies without a status remain active. Suspension blocks fresh password/Google sign-in and every subsequent tenant JWT authorization check, including already-issued JWTs. Public invitation acceptance also rejects suspended companies without consuming the invitation. An operation already authorized before suspension is not forcibly interrupted; subsequent requests check committed database status. Suspension does not delete data, revoke invitations, change plans/anchors/usage, cancel Stripe subscriptions or touch S3. Stripe webhooks and reconciliation continue to maintain provider state.

Reactivation restores access for unexpired tenant JWTs and permits login, while existing activation/payment/entitlement restrictions still apply. It never activates an unverified company or clears a payment restriction. Repeated status transitions return 409; missing companies return 404. Concurrent transitions use conditional writes in a MongoDB transaction, and audit failures roll back the status change.

Audit records contain only actor/target IDs, enum action/reason/status and creation time; no submitted credentials, arbitrary request bodies, tokens, payment methods or customer-sensitive payment data. Records have no TTL. Mongoose rejects audit updates/deletions/replacements and bulk rewrites; no API exposes these mutations. Restrict direct database administration privileges separately: schema middleware is not a tamper-proof boundary against privileged direct database access. Projections hide password hashes, verification/invitation tokens, lease/operation internals, webhook data, storage keys, AWS/SMTP/Stripe secrets and file contents. Existing tenant APIs remain the only file-content access path and reject platform tokens.

### Disposable unactivated signup cleanup (CLI only)

There is no company deletion API. Signup commits a company, owner, Free subscription and verification record before attempting SMTP delivery; an email failure can therefore leave a saved, unactivated signup. Email activation consumes the verification record and sets **Company** `activatedAt`. The Free subscription's separate `activatedAt` anchor is populated during signup and must not be mistaken for email activation. Verification records can expire through MongoDB TTL, so their absence alone does not prove activation or disposability.

Use a trusted local API client with a platform JWT to identify your exact accidental signup: `GET /admin/users?role=company_owner&search=…` searches safe email/name metadata and returns its `companyId`; `GET /admin/companies/:id` confirms company name, owner email, activation and subscription state. Check both identity and company ID against the signup you personally created. Keep authentication headers out of shared workspaces, saved requests and terminal history. The utility cannot infer whether an email is fake or inaccessible; an eligible legitimate pending signup must never be selected.

With the intended **development/test** database configured privately through `MONGO_URI` and explicit `NODE_ENV=development` or `test`, build and inspect only:

```bash
npm run build
npm run maintenance:cleanup-disposable -- --company-id REPLACE_WITH_EXACT_COMPANY_ID
```

This defaults to a read-only transactional dry run and returns only the company ID, eligibility, mode and record counts. It creates no collections/indexes and loads no tenant HTTP server, payment workers, SMTP or S3 services. Production, unspecified environments, selectors, bulk operations, force flags and invalid IDs are rejected. Environment labeling is a guard, not proof of the database target: never relabel a production database to bypass it.

If the dry run is eligible **and you independently confirmed it is your disposable signup**, stop **every API instance, reconciliation worker and other database writer** using that database, then run:

```bash
npm run maintenance:cleanup-disposable -- --company-id REPLACE_WITH_EXACT_COMPANY_ID --confirm-disposable --confirm-app-stopped
```

The second run rechecks everything inside the deletion transaction. `--confirm-app-stopped` attests an offline maintenance window; the utility cannot detect all other processes. Do not run while application instances, CLI writers or manual database edits remain active. Conditional writes and transaction conflicts protect competing activation/record changes; offline maintenance additionally prevents phantom dependent inserts.

Deletion refuses anything outside the untouched signup shape: non-null/missing company activation, suspended/reactivated status history, changed timestamps/version/unknown fields, missing or duplicate owner/subscription, any accepted employee, non-Free plan, accounting revision, payment restriction, any Stripe identifier/operation/history/outbox, any stored-file/uploader reference, any invitation/inviter reference (including expired/revoked ones still present), **any billing-period row even with zero usage**, any AI conversation/message/usage reference, inconsistent verification ownership, or audit references to the company/owner. Historical string references are also checked case-insensitively rather than silently omitted by ObjectId casting. An expired verification record may be absent; a resent verification record may remain.

Only that exact company, its single owner, pristine Free subscription and zero/one verification records can be removed. All deletions use one snapshot/majority transaction with exact count checks; failures roll back partial work. Audit history is never deleted. It never contacts Stripe/AWS/SMTP or attempts S3 cleanup. A refusal requires investigation, not removing the safeguards. Reports contain no email, password/hash, verification token or database/provider exception text. Restart the application after maintenance. Repeat deletion reports `company_not_found`, not success.

### Reset an unused Stripe Test Mode customer mapping (CLI only)

After moving a **development/test** database to another Stripe Test Mode account, an old customer ID can prevent a new hosted Checkout. This command handles only an existing company that is still on the local **Free** plan with an unused Stripe customer mapping. It refuses Stripe-managed or paid subscriptions, a known subscription ID/status, a checkout session or attempted checkout/subscription creation, pending plan/schedule/lease/meter/sync state, and any company-scoped Stripe webhook-event or metered-usage record. A refusal means the old account and DataVault state require individual reconciliation; do not manually force a paid plan into an unmanaged state. It never calls Stripe or changes company/users/files/invitations, billing-period/upload records, AI records or platform-admin data. It does not delete webhook history or the usage outbox.

Build, set `NODE_ENV=development` or `test` for the intended non-production database, and **dry-run** with the exact company ObjectId:

```bash
npm run build
npm run maintenance:reset-stripe-test -- --company-id REPLACE_WITH_EXACT_COMPANY_ID
```

The JSON report lists field **names**, not Stripe identifier values, and gives the subscription `revision`. Confirm the company and plan independently. Before execution, configure the **new account's Test Mode** `STRIPE_SECRET_KEY` privately (the CLI checks its `sk_test_` shape but never calls Stripe or prints it), stop **all** API instances, payment workers and other writers using that database, and confirm no old-account Checkout/subscription operation or webhook delivery remains in flight. The CLI cannot inspect the old Stripe account or prove that distributed processes are stopped. Then use the revision from the dry run:

```bash
npm run maintenance:reset-stripe-test -- --company-id REPLACE_WITH_EXACT_COMPANY_ID --expected-revision REPLACE_WITH_DRY_RUN_REVISION --execute --confirm-reset --confirm-app-stopped --confirm-old-stripe-quiescent
```

Execution rechecks the exact company and subscription under a snapshot/majority MongoDB transaction, conditionally increments `revision`, and clears only Stripe provider mapping/operation/synchronization fields. It retains the Free plan, activation/billing anchor and all authoritative usage. `NODE_ENV=production` or an unset environment is refused even for a dry run. The confirmation flags are operator attestations, not process detection. No HTTP reset endpoint exists. The old Stripe customer remains in the old Test Mode account; handle that account separately if needed. Restart the application only after maintenance is complete.

For the **separate, exact unmanaged Basic recovery case**, add `--recover-unmanaged-basic` to the dry run. This mode applies only when a local Basic subscription has `stripeManaged=false`, `paymentAccess=unmanaged`, `paymentSyncIssue=retry_required`, an old **Test Mode setup Checkout** for Premium, and no Stripe subscription ID or subscription-creation attempt. It also requires no company-scoped Stripe event/outbox records, exactly one owner and no employees, no live pending invitations, at most the Free allowance of successful uploads in the current activation-anchored period, and no recorded overage. These are the same capacity constraints used for a Free downgrade. A completed setup Checkout alone does not collect payment or create a subscription; DataVault creates the subscription in a later step, after recording its attempt. Any evidence that step began, any paid/managed state, or a failed Free capacity check causes refusal. Do not clear those states manually.

```bash
npm run maintenance:reset-stripe-test -- --company-id REPLACE_WITH_EXACT_COMPANY_ID --recover-unmanaged-basic
```

After independently reviewing the dry-run report and stopping every writer, confirm that the old Test Mode account has no in-flight Checkout/webhook activity. Run from an isolated `development`/`test` maintenance process connected only to the intended staging database, not from the Render production-mode web process. With the new account's `sk_test_` secret configured privately, use **the Basic recovery revision from this dry run**:

```bash
npm run maintenance:reset-stripe-test -- --company-id REPLACE_WITH_EXACT_COMPANY_ID --recover-unmanaged-basic --expected-revision REPLACE_WITH_DRY_RUN_REVISION --execute --confirm-reset --confirm-transition-to-free --confirm-app-stopped --confirm-old-stripe-quiescent
```

This transaction changes only that company's subscription: `planCode` becomes `free`, `planChangedAt` becomes the recovery time, `revision` increments, payment access/sync state becomes unmanaged/none, and old Stripe mapping/operation/sync fields are cleared. The original `activatedAt` billing anchor and every user, invitation, file, subscription-period/upload counter, AI record, other tenant and Stripe event/outbox record remain untouched. The old customer/setup session remain in the old Stripe account. After restarting DataVault with the new Test Mode account, the owner may begin a new hosted Checkout. A company that cannot fit Free needs explicit account/payment reconciliation; this utility cannot grant or preserve unpaid Basic access.

### Real API platform-admin smoke test

Run against a local/test Nest API, with normal SMTP and frontend activation available. Use a **new accessible email address** (an operator-controlled alias works) and a dedicated password; each run registers a new fixture. Never supply an existing tenant/account. Start the application normally, then in an interactive terminal:

```bash
npm run build
npm run admin:smoke -- --base-url http://127.0.0.1:3000 --confirm-test-tenant
```

The helper accepts only loopback origins (or a locally forwarded test API), refuses URL credentials/query/path fragments, follows no redirects, and requires a TTY. Choose `token` to enter a platform JWT or `login` to enter platform email/password. All answers, including tenant email/password and JWTs, use hidden prompts; never pass them as arguments, pipe them from files, or enable HTTP tracing. Tokens and snapshots remain in process memory and are not printed/persisted. Only fixed checkpoint labels, HTTP failure status and the generated fixture name/company ID are output. Bootstrap `.env` values are not modified or used by this helper.

It validates platform access **before registration** and registers a unique `DataVault admin smoke …` company using the supplied company profile. The activation email URL is a frontend route: production frontend code must read its `token` query parameter and send `POST /auth/verify-account` with JSON `{ "token": "…" }`. For development without that frontend, the CLI securely prompts for either the full activation URL copied from the email or its raw token, validates it without printing it, and calls that same normal backend endpoint. It never calls an activation bypass or edits MongoDB. It then signs in, retains the original tenant JWT, proves normal tenant access and `/admin` rejection, and verifies that the exact fixture is Free, empty, employee/invitation-free and Stripe-unmanaged before any suspension.

Choose `login` to obtain a fresh 30-minute platform token, then enter the bootstrap admin email and password. The hidden prompt safely accepts normal bracketed terminal paste. Authentication is verified before tenant details are requested. Safe failure stages distinguish rejected credentials, a rejected supplied JWT, a newly issued JWT rejected by the dashboard, and unreachable, unavailable, or misconfigured admin endpoints; credentials and response bodies are never printed.

It suspends only that fixture, checks both the already-issued JWT and fresh login return 401, compares safe owner/subscription/billing/files/usage/Stripe metadata, reactivates, and proves the **original** JWT works again with unchanged business state. It never uploads files, invites employees, changes plans, calls `/payments` or touches other tenants. These are API-visible checks, not a live provider-state reconciliation or inspection of hidden internal fields.

After a failure following suspension, the helper attempts scoped reactivation only if that exact generated fixture still has its own `operational_hold` reason; competing security suspensions are not cleared. A lost HTTP response is handled through the same read/check/recovery path. If recovery fails or the process is forcibly terminated, inspect the generated fixture through `/admin/companies/:id` and reactivate only it when appropriate. Network/email failures may leave registration saved; use the printed unique fixture name to locate it instead of blindly rerunning with an existing email. No automatic registration/plan mutation retries are performed.

If registration succeeded but activation or tenant login interrupted the run, resume that exact generated fixture instead of registering another tenant:

```bash
npm run admin:smoke -- --base-url http://127.0.0.1:3000 --resume-fixture "DataVault admin smoke REPLACE_WITH_THE_EXACT_UUID" --confirm-test-tenant
```

Resume authenticates the platform administrator, searches for one exact generated fixture name, loads its admin detail, and refuses to proceed unless the owner email matches and the tenant is pristine Free state with no employees, invitations, files, usage, Stripe state, prior suspension, or integrity warning. A pending fixture prompts for its existing email activation URL/token and submits it once to `/auth/verify-account`; an already activated pristine fixture skips token submission. It then continues the normal login, isolation, suspension/reactivation, and state-preservation checks. Resume never calls signup or resend-verification and never rotates the token. A 400 at `activation` means the token is invalid, consumed, or expired; inspect whether activation already completed before considering the normal resend endpoint.

Successful smoke tests intentionally retain their **activated, reactivated fixture and audit history**. The unactivated cleanup utility must refuse them. Use a dedicated disposable test database for repeat runs rather than weakening cleanup rules to remove activated tenants. Complete activation within the administrator token's 30-minute lifetime; expired tokens fail safely.

Bootstrap failures now report only fixed categories: `invalid_bootstrap_configuration`, `mongo_connection_failed`, `mongo_index_failed`, `mongo_query_failed`, `mongo_transaction_failed` or `mongo_close_failed`. Invalid credentials/configuration are checked before connecting; index initialization and transactions are separately classified. Check configuration/permissions/replica-set support locally, without pasting raw errors or secrets into logs.
