# Polymarket Quant Engine

Polymarket Quant Engine is a paper-first terminal for active crypto Up/Down markets. It discovers 5m and 15m markets, shows public books and Coinbase chart context, produces heuristic UP/DOWN/PASS decisions, records a complete market ledger, and keeps the Paper Trader and Paper Lab on one shared account.

## Included

- Public Gamma discovery for active crypto 5m/15m markets, public CLOB order books, and public Coinbase spot/candle data.
- Every discovered market remains visible, including PASS decisions caused by missing data, weak edge, stale candles, or wide spreads.
- One-second countdowns plus Coinbase and Polymarket market WebSocket updates with REST recovery refreshes.
- Transparent chart signal fields: model P(UP), UP/DOWN asks, net edge, 5m/15m trends, confidence, liquidity, and reason.
- One shared paper account for manual Paper Trader entries, automatic entries, timeframe tests, balance, open positions, closed positions, realized P&L, and resolution payouts.
- Resolution-aware paper settlement: winning shares pay $1, losing shares pay $0 when an expired market outcome is available; realized cash flows into the same balance used by newly opened markets.
- Browser-local decision ledger for all active markets with UP/DOWN/PASS, outcomes, timestamps, sizing, and CSV export.
- Timeframe paper tests with a chosen starting balance and duration, Telegram test/report delivery, and Sunday 9 PM Eastern browser-assisted scheduling.
- Optional owner-authenticated Polymarket account reads and live execution gates in the hosted Site, with balance checks, risk limits, fractional Kelly sizing, duration filters, pause, and cancel-all controls.
- Model-aware cashouts for paper positions and an opt-in live exit policy: the current executable bid must clear the model fair probability, minimum dollar/percentage profit, remaining-time, and repeated-confirmation checks before a sell is attempted. The server revalidates the position and market immediately before submitting a non-retried FAK sell.

The model is heuristic and uncalibrated. Nothing in the interface guarantees a profit or a fill. Live orders use real funds and must be independently tested with paper data first.

## Clone this repository

```bash
git clone https://github.com/coopermsick-67/polymarket-quant-engine.git
cd polymarket-quant-engine
```

The repository is public and can be cloned without GitHub credentials.

## Run locally

Requirements: Node.js 22.13+ and pnpm 11.25.0.

```bash
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install
pnpm run dev
```

Open the local URL printed by the terminal. For a production-style local worker:

```bash
pnpm run build
pnpm run start -- --port 8787
```

Then open `http://127.0.0.1:8787`.

## Keep it running on an old Windows computer

Run these once from the project root:

```powershell
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install
pnpm run build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run_forever.ps1
```

The supervisor restarts the local server if it exits. Open `http://127.0.0.1:8787` in Chrome and keep that tab open and awake. The browser tab performs public market scanning, paper fills, market-resolution settlement, ledger persistence, and the Telegram weekly check; running only the server is not a background trading process.

To start it after every Windows logon, create a Task Scheduler task that runs:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\polymarket-quant-engine\scripts\run_forever.ps1
```

Keep the computer plugged in, disable sleep while connected to power, and configure Chrome to reopen the local tab after reboot. Never put a wallet private key, Telegram bot token, or API secret in GitHub or a committed `.env` file.

## Linux/macOS supervisor

```bash
pnpm install
pnpm run build
bash scripts/run_forever.sh
```

Use `systemd`, `launchd`, or a login service to start that script after reboot. The browser tab requirement still applies for the client-side market loop.

## Headless Linux paper daemon

The separate `pnpm run daemon` process runs the deterministic strategy without a browser tab. It is deliberately paper-only: it refuses `TRADING_MODE=live`, uses public market data, records a persistent simulated account, and checks final outcomes against Gamma before settling expired positions. It does not sign or submit live orders.

The daemon exposes loopback-only `/healthz` and `/status` endpoints on port 8788. It latches a stale-data halt after 90 seconds without a complete fresh market snapshot, has paper exposure and daily-loss limits, validates the paper ledger on every cycle, and supports pause and kill switches. Daily-loss limits halt new entries but do not force-close open positions. When Gamma omits the opening reference, paper mode can use the matching Coinbase candle open as a labeled estimate; Polymarket’s Chainlink TWAP may differ, and live execution still requires a Polymarket reference. The Linux systemd unit, log rotation, restricted Hermes watchdog permissions, and host commands are in [`deploy/README.md`](deploy/README.md).

For an interactive terminal monitor, start the daemon in one terminal and run `pnpm run dashboard` in another. The monitor clock, countdowns, and display refresh every second with account cash/equity/P&L, open positions, recent fills and closed trades, current signals, feed freshness, and halt state. The daemon updates marks from Coinbase and subscribes to Polymarket book streams for open positions while keeping market discovery on its 15-second REST cycle. Press `q` to exit the monitor without stopping the daemon or `r` to refresh immediately. If it reports that the endpoint is unreachable, start `pnpm run daemon` in a separate terminal. It reads the daemon's loopback-only status endpoint and does not place orders.

Paper mode requires no API keys or wallet credentials. Keep any future live credentials in host-only secret storage; this daemon has no live executor, and the dashboard's browser-authenticated live routes are not part of this service.

## Local environment

Paper mode works without secrets. Copy `.env.example` to `.env.local` only when configuring local server values, and keep that file untracked. The hosted Site supplies the owner-authenticated ChatGPT headers required by production live execution.

Live linking retries transient Polymarket credential, balance, and open-order reads. If the upstream socket is reset, the request returns a readable error and no order is retried or assumed successful; reconcile the Account view before trying any uncertain execution again. Live buy and sell submissions are disabled unless the server-side `POLYMARKET_LIVE_EXECUTION_ENABLED` value is exactly `true`; keep it `false` for paper operation. The daemon's `TRADING_MODE` setting is separate and remains paper-only.

For live execution on a trusted localhost machine, explicitly opt in to the loopback-only gate and provide a 32-byte session secret:

```text
POLYMARKET_LIVE_ALLOW_LOCALHOST=true
POLYMARKET_LIVE_SESSION_SECRET=<64 hexadecimal characters>
POLYMARKET_LIVE_EXECUTION_ENABLED=false
POLYMARKET_TELEGRAM_SESSION_SECRET=<another 64 hexadecimal characters>
```

Generate each session secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, restart the server, and then link the wallet or Telegram bot in the local dashboard. Local live and Telegram sessions are encrypted, and the local bypass requires a matching localhost request host without forwarding headers. The Fetch API does not expose the socket peer, so bind the app directly to loopback and never put this bypass behind a reverse proxy. Keep `POLYMARKET_LIVE_EXECUTION_ENABLED=false` unless you have independently established live readiness and deliberately intend to submit real orders. The localhost flag must remain `false` on shared or production deployments.

## Safety and live integration boundary

The official Polymarket APIs separate Gamma market metadata, CLOB books/orders, the Data API for positions/activity, Relayer wallet transactions, and public/authenticated WebSocket channels. Before enabling live trading, independently verify market selection, wallet/account type, L1/L2 signing, balance reconciliation, order/fill reconciliation after restart, stale-data halts, fees, slippage, and exposure limits.

See `SETUP.md`, `ARCHITECTURE.md`, `STRATEGY.md`, `RISK.md`, and `API.md` for project details.
