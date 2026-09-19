# Setup

## Development

1. Install Node.js 22 or later.
2. Run pnpm install.
3. Copy .env.example to .env only if a server-side adapter is being developed.
4. Start with pnpm run dev.
5. Open the dashboard and keep PAPER mode selected.

## Checks

    pnpm exec tsc --noEmit
    pnpm run lint
    pnpm run build

## Before live credentials

Do not add a private key to client code, NEXT_PUBLIC variables, localStorage, query strings, screenshots, or logs. Live mode should be enabled only by a backend readiness check that confirms credentials, wallet/account resolution, balance, market data, user stream, risk configuration, and reconciliation health.

## Official surfaces

- Gamma: https://gamma-api.polymarket.com
- CLOB: https://clob.polymarket.com
- Data API: https://data-api.polymarket.com
- Relayer: https://relayer-v2.polymarket.com
- Public market WebSocket: wss://ws-subscriptions-clob.polymarket.com/ws/market
- Authenticated user WebSocket: wss://ws-subscriptions-clob.polymarket.com/ws/user
- RTDS: wss://ws-live-data.polymarket.com
