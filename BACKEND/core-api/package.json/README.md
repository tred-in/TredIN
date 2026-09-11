# TredIN — TrueData Market Adapter

This is the server-side market-data boundary for TredIN. It keeps TrueData credentials out of the browser and converts the provider stream into a small TredIN API.

## Flow
TrueData WebSocket → adapter → `/market/quotes` + `/market/stream` → TredIN frontend

## Endpoints
- `GET /health` — provider connection status
- `GET /market/instruments` — configured TredIN ↔ TrueData symbol map
- `GET /market/quotes` — latest provider-backed quotes; unknown values stay `null`
- `GET /market/stream` — SSE quote stream for browser clients

## Run
1. Copy `.env.example` to `.env`.
2. Put TrueData credentials only in `.env` on the server.
3. Set `TRUEDATA_REALTIME_PORT=8086` for sandbox or `8084` for production, according to the TrueData subscription/environment.
4. Replace `TREDIN_SYMBOL_MAP` with the exact subscribed TrueData symbols from the symbol master. Do not guess option symbols.
5. `npm install`
6. `npm start`

The adapter does not create prices, fills, positions, balances, or order states. It only relays provider-backed market data. Orders, RMS, margin, funds, KYC and audit remain TredIN-backend responsibilities.

## Security
Never commit `.env`. Rotate any provider credentials that were exposed in documents or screenshots before production.
