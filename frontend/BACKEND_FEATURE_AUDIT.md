# Backend/frontend feature audit — 2026-10-05

This compares the local Nest API and the Next.js UI. “Wired” means the screen calls the backend route; external services still require configuration and a live account for end-to-end proof.

| Capability | Backend | Frontend | Demo status |
| --- | --- | --- | --- |
| Email registration, activation, resend, sign-in | `/auth/*` | `/register`, `/activate`, `/login` | Wired. Duplicate email shows an account-exists panel with sign-in and resend paths. Requires working SMTP and frontend activation URL for live email. |
| Google sign-in and sign-up | `/auth/google`, callback, exchange, register | `/login`, `/register` | Wired. Existing users sign in; new users supply company name, country, and industry on the same registration page. Requires Google OAuth credentials and registered callback. |
| Employee invitations and acceptance | `/invitations/*` | Employee management and `/employee-activate` | Wired. Email delivery and invitation URL must be configured. |
| Company, profile, password | `/companies/current`, `/users/*` | Dashboard settings, profile, and employee details | Owners can view and rename employees; members can edit their own profile. |
| Plans and billing | `/plans`, `/subscriptions/*`, `/payments/*` | Plans, billing, Stripe return pages | Wired. Live Stripe flow needs backend test-mode setup and webhook; no card details pass through the frontend. |
| Files and permissions | `/files/*` | File library | Upload, download, delete, and permissions are wired. The backend is authoritative for storage availability and access; S3 must be configured on Render. |
| Statistics and AI | `/statistics/current`, `/ai/*` | Dashboard and assistant | Wired. AI requires a configured provider; disabled state is shown in the UI. |
| Platform administration | `/admin/auth/*`, access requests, dashboard, companies, users, files, audit logs, company suspend/reactivate | `/admin` | Wired with a separate platform-admin JWT and session, access request review, and password recovery. Bootstrap the first platform admin with `npm run admin:bootstrap`; ordinary company owners do not have platform access. |

## Backend features without a matching screen

- Tenant password recovery/reset, tenant activity feed, notifications, workspace switching, and email changes have no backend endpoints and therefore no working UI. The tenant recovery page explains the limitation.
- `/health/live`, `/health/ready`, and the signed `/payments/webhook` are operational or server-to-server endpoints and have no user screen.
- Platform admin bootstrap remains a CLI operation; subsequent access requests and password recovery are available on the admin screen.

## Lecturer demo prerequisites

Run the backend and frontend, set their URL environment variables, and prepare an activated tenant account plus a bootstrapped platform admin. To demonstrate real email activation, verify the SMTP sender and activation URL; to demonstrate Google, configure the Google OAuth client/callback; to demonstrate files, configure S3; to demonstrate Stripe or AI, configure those providers separately. Browser tests use mocked API responses, so a live external-provider demo still needs those credentials and services.
