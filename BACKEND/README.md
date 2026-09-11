# TredIN Core Backend — execution-safe foundation

This package is the next backend boundary after the TrueData market adapter.

## Locked behavior
- Market data comes only from the TrueData adapter.
- Browser is never the source of truth.
- No fake fills, fake balances, fake positions, or fake financial mutations.
- Order submission stays blocked until a real execution adapter is configured.
- Finance mutations stay blocked until a real ledger/payment workflow is configured.
- PostgreSQL is the intended source of truth.

## Services
- Core backend: port 8788
- TrueData adapter: port 8787
- PostgreSQL: configured with DATABASE_URL

## Setup
1. Copy `.env.example` to `.env` and set DATABASE_URL + a strong JWT_SECRET.
2. Run `sql/schema.sql` on PostgreSQL.
3. Start the TrueData adapter first.
4. `npm install && npm start`
5. Point the TredIN HTML API base URL to `http://YOUR-SERVER:8788`.

## Important
The code intentionally returns explicit `503/501` responses where a real execution, authentication verifier, KYC workflow, or finance ledger has not yet been connected. This is deliberate: it prevents the frontend from silently behaving like a fake broker.

## Admin authentication
Run `ADMIN_USER_ID=admin@tredin.in ADMIN_PASSWORD='YOUR_STRONG_PASSWORD' npm run provision-admin` once against PostgreSQL. The password is stored only as an scrypt hash. Admin login uses `POST /auth/login`; the token carries the SUPER_ADMIN role. Never put admin credentials in HTML or commit `.env`.

## KYC + Finance request workflows
- KYC submit/status are now server-stored.
- Deposit/withdraw are request-only: they never mutate balance directly.
- Finance/Admin approval is required before any ledger mutation.
- No payment gateway or bank settlement is fabricated.

## Admin bootstrap
`ADMIN-CREDENTIALS-ONE-TIME.txt` contains a one-time bootstrap credential for local/deployment provisioning. Delete it after provisioning and rotate the password.

## Step 10 — Notifications + Support
Run `sql/support_notifications.sql` after the base schema. User APIs: GET `/notifications`, POST `/notifications/read-all`, GET/POST `/support`, GET `/support/:id`, POST `/support/:id/reply`. Admin Support APIs: GET `/admin/support`, GET `/admin/support/:id`, POST `/admin/support/:id/reply`, POST `/admin/support/:id/close`. Notifications are server-authoritative and support actions are audited.


## Deployment environment
Set `CORS_ORIGIN` to the comma-separated exact origins of the deployed USER and ADMIN Netlify sites. Set `JWT_SECRET` to a strong secret. The frontend defaults to the Render core API origin but can be overridden with `window.TREDIN_CONFIG.apiBaseUrl`.
