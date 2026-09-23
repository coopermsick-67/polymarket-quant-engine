# Setup

Requirements: Node.js 22.13+ and pnpm 11.25.0 (`corepack enable && corepack prepare pnpm@11.25.0 --activate`).

```bash
pnpm install
pnpm run check        # typecheck + lint + prettier + tests
pnpm run dev          # dashboard
pnpm run headless -- --auto --record   # 24/7 paper/shadow engine, no browser
pnpm run replay -- data/replay-YYYY-MM-DD.jsonl --walk-forward
```

## Environment (`.env.local`, never committed)

| Variable | Purpose |
| --- | --- |
| `POLYMARKET_LIVE_SESSION_SECRET` | 64 hex chars. Seals live-session and daily-risk cookies. Required for live. |
| `POLYMARKET_TELEGRAM_SESSION_SECRET` | 64 hex chars. Seals the Telegram cookie. |
| `POLYMARKET_LIVE_ALLOWED_USER_ID` | Owner id on hosted deployments. |
| `POLYMARKET_LIVE_ALLOW_LOCALHOST` | `true` only on a trusted single-user machine; enables loopback owner access. |
| `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_WALLET_ADDRESS`, `POLYMARKET_SIGNATURE_TYPE` | Server-held signer (recommended). The key never reaches the browser. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Alerts from the headless runner. |

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Before trading real money

1. Run the headless runner with `--record` for days, not hours.
2. `pnpm run replay -- data/*.jsonl --walk-forward` and require, out of sample: positive realized edge with a confidence interval that excludes zero, a model (or posterior) Brier score below the book's, and non-negative 5 s markouts.
3. Start live with the default policy (LOCK tier, $25 max trade, 5% daily stop, BTC/ETH/SOL/XRP) and compare live fills against the paper engine's simulated fills.
