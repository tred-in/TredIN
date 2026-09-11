# TredIN Broker + RMS Boundary

This layer is deliberately non-fake. It performs server-side order gates but does **not** invent broker acknowledgements, fills, balances, positions, or P&L.

## Flow
User/API -> Order Validation -> RMS -> Broker Adapter -> Broker ACK -> Execution Callback -> Position/Ledger -> Audit

## Current state
- RMS validation boundary: implemented.
- Broker adapter interface: implemented.
- Real broker credentials/API: not supplied, therefore not connected.
- Execution/fill simulation: disabled.
- Financial mutation without broker/backend authority: blocked.

## Required next integration
Provide the selected broker's official API documentation/credentials through the backend environment (never HTML). Then implement:
1. authentication/session
2. instrument/token mapping
3. order placement
4. order status polling/webhook
5. cancellation
6. execution/fill reconciliation
7. position reconciliation
8. ledger reconciliation
9. idempotency and duplicate-order protection
10. broker outage/retry/circuit-breaker handling
