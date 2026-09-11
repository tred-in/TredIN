# TredIN Internal Execution Control Plane

This layer keeps order intake, RMS state, cancellation, idempotency and audit inside TredIN without pretending that an exchange fill occurred.

## Flow
`UI -> Core API -> RMS -> ORDER(RMS_PENDING) -> authorised venue/exchange adapter -> execution -> position -> ledger`

Until a legally/technically authorised venue adapter exists, the system will **not** create executions, positions or financial ledger mutations from an order request.

## Current guarantees
- Server-side order validation
- Instrument enable/disable gate
- RMS rejection codes
- Client-order idempotency
- Order state storage
- User order list/detail
- User cancellation for non-terminal orders
- Audit records
- No fake fills
- No fake P&L
- No fake balance changes

## Production boundary
A real execution adapter must be separately authorised and connected before `ACKNOWLEDGED`, `PARTIALLY_FILLED`, or `FILLED` states can be written from venue evidence.
