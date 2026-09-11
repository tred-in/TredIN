# TredIN — easiest Render deployment

1. Push this repository to GitHub.
2. In Render: New → Blueprint → select the GitHub repository.
3. Render reads `render.yaml` and creates USER, ADMIN, Core API, Market Adapter and PostgreSQL.
4. During the first Blueprint setup, enter these secrets when prompted:
   - `ADMIN_USER_ID` — your admin login ID
   - `ADMIN_PASSWORD` — minimum 14 characters
   - `TRUEDATA_USER`
   - `TRUEDATA_PASSWORD`
   - `TREDIN_SYMBOL_MAP` — JSON symbol mapping supplied by TrueData
5. Deploy. Core automatically initializes the PostgreSQL schema and provisions the SUPER_ADMIN.
6. Open the generated `tredin-user-live` URL for the user app and `tredin-admin-live` URL for admin.

## Important
Free Render services are for testing/preview. Free web services can sleep, and free Postgres expires after 30 days. For continuous live market operation, upgrade the Core API, Market Adapter and database to paid plans.
