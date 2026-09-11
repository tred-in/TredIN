# TredIN Position + P&L + Margin + Reconciliation

This layer is evidence-driven:
- Positions are based only on stored venue executions.
- Realized P&L is calculated when an execution changes an existing position.
- Unrealized P&L requires an authoritative market mark from the TrueData adapter.
- Margin reservations are server-side RMS records and do not create cash balances.
- Reconciliation is structural until an authorised execution/payment venue is connected.
- No fake fills, fake P&L, fake cash or synthetic execution is generated.

## New API
- `GET /positions`
- `GET /portfolio/summary`
- `GET /risk/margin`
- `POST /admin/reconciliation/run`

Run `sql/schema.sql` then `sql/portfolio.sql`.
