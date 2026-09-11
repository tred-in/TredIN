# TredIN COMPLETE FINAL

This package contains the two separate frontend deployments plus the Render backend required for real market/API operation.

## Folders
- USER/ — deploy as the customer Netlify site.
- ADMIN/ — deploy as the separate admin Netlify site.
- BACKEND/ — deploy on Render: Core API + TrueData Market Adapter + PostgreSQL.

## Required Render environment
Core API:
- DATABASE_URL (Render PostgreSQL)
- MARKET_ADAPTER_URL (Render market-adapter URL)
- CORS_ORIGIN = comma-separated USER and ADMIN Netlify origins
- JWT_ISSUER = tredin
- JWT_SECRET = strong random secret
- ADMIN_USER_ID
- ADMIN_PASSWORD

Market Adapter:
- TRUEDATA_WS_URL
- TRUEDATA_USER
- TRUEDATA_PASSWORD
- TREDIN_SYMBOL_MAP (exact symbols from the subscribed TrueData symbol master)

Do not put TrueData credentials in either USER or ADMIN HTML.

## Important
The package is deployment-ready, but this environment cannot log into or deploy to the user's Netlify/Render accounts. Live market data becomes available only after the Render services are deployed and TrueData credentials/symbol map are configured.

## Final micro-audit fixes applied (2026-09-11)
- Corrected Render service `rootDir` paths to `BACKEND/core-api` and `BACKEND/market-adapter`.
- Changed Render builds to `npm install --omit=dev` because this package intentionally ships without lockfiles.
- Made Core API CORS allow-list environment-driven and support comma-separated origins/subdomain patterns.
- Disabled bundled frontend test credentials in both USER and ADMIN builds; production authentication is backend-authoritative.
- ADMIN portal now enforces authorized admin roles after live login and opens into a dedicated Admin Control Center.
- Added admin views for Users, Orders, KYC, Finance, Risk, Support, Audit and Reconciliation, using server APIs.
- Expanded ADMIN sync to all available admin data endpoints.
- Removed the unreachable duplicate `/positions` route.
- Made finance approval/rejection transaction-safe with PostgreSQL `BEGIN/COMMIT/ROLLBACK` and row locking.
- Refreshed the API contract map so implemented admin endpoints are no longer listed as missing.
