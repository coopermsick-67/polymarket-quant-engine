# Setup

## Development

1. Install Node.js 22.13 or later and pnpm 11.25.0 (`corepack enable && corepack prepare pnpm@11.25.0 --activate`).
2. Run `pnpm install`.
3. Copy `.env.example` to `.env.local` only for local server settings. Never put a private key in any env file; the terminal trader asks for it at a hidden prompt.
4. Run `pnpm run dev` for the terminal UI, or `pnpm run daemon` for the headless paper engine.

## Checks

These are the same checks CI runs (`.github/workflows/ci.yml`):

    pnpm test
    pnpm run typecheck
    pnpm run lint
    pnpm run build
    pnpm audit --prod

## Deployment modes

- **Local:** bind the server to 127.0.0.1. `POLYMARKET_LIVE_ALLOW_LOCALHOST=true` lets the local owner link a wallet session (read state, cancel orders).
- **Hosted:** set `POLYMARKET_HOSTED=true`. It disables the local-owner bypass regardless of other settings. The UI never asks for a key and reads wallets through public data or read-only CLOB API credentials.
- **Live orders:** `pnpm run live` in a trusted terminal, after paper evidence exists (see README, Model calibration).

## Official surfaces

- Gamma: https://gamma-api.polymarket.com
- CLOB: https://clob.polymarket.com
- Data API: https://data-api.polymarket.com (`/v2/positions` is cursor-paginated; `filter_amount=0` and `include_archived=true` return the full inventory; combos are on `/v2/positions/combos`)
- Public market WebSocket: wss://ws-subscriptions-clob.polymarket.com/ws/market
- RTDS: wss://ws-live-data.polymarket.com
