# TredIN Admin Fund Control

This module is intentionally kept separate from the legacy monolithic Admin UI. It exposes a small authenticated client for customer lookup and idempotent fund credit against the Core API. The UI should load this file only after an authenticated admin session is established.

Endpoints:
- GET /admin/funds/users?search=...
- POST /admin/funds/credit with Idempotency-Key

No production fund credit is executed by this integration file itself.
