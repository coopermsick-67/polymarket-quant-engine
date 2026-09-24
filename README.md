# Polymarket Quant Engine

Polymarket Quant Engine is a paper-first terminal for active crypto Up/Down markets. It discovers 5m and 15m markets, shows public books and Coinbase chart context, produces heuristic UP/DOWN/PASS decisions, records a complete market ledger, and keeps the Paper Trader and Paper Lab on one shared account.

## Included

- Public Gamma discovery for active crypto 5m/15m markets, public CLOB order books, and public Coinbase spot/candle data.
- Every discovered market remains visible, including PASS decisions caused by missing data, weak edge, stale candles, or wide spreads.
- One-second countdowns plus Coinbase and Polymarket market WebSocket updates with REST recovery refreshes.
- Transparent chart signal fields: model P(UP), UP/DOWN asks, net edge, 5m/15m trends, confidence, liquidity, and reason.
- One shared paper account for manual Paper Trader entries, automatic entries, timeframe tests, balance, open positions, closed positions, realized P&L, and resolution payouts.
- Bankroll-adaptive paper sizing for MICRO ($20–49.99), SMALL ($50–99.99), GROWTH ($100–249.99), STANDARD ($250–999.99), and LARGE ($1,000+) liquidation equity, with tier-specific cash reserves, concentration, spread, depth, edge, and drawdown gates.
- Resolution-aware paper settlement: winning shares pay $1, losing shares pay $0 when an expired market outcome is available; realized cash flows into the same balance used by newly opened markets.
- Browser-local decision ledger for all active markets with UP/DOWN/PASS, outcomes, timestamps, sizing, and CSV export.
- Timeframe paper tests with a chosen starting balance and duration, Telegram test/report delivery, and Sunday 9 PM Eastern browser-assisted scheduling.
- Optional owner-authenticated Polymarket account reads and live execution gates in the hosted Site, with balance checks, risk limits, fractional Kelly sizing, duration filters, pause, and cancel-all controls.
- Model-aware cashouts for paper positions and an opt-in live exit policy: the current executable bid must clear the model fair probability, minimum dollar/percentage profit, remaining-time, and repeated-confirmation checks before a sell is attempted. The server revalidates the position and market immediately before submitting a non-retried FAK sell.

The raw model is heuristic and uncalibrated by default. Walk-forward calibration diagnostics require settled outcomes and sufficient prior samples; they do not establish profit. Nothing in the interface guarantees a profit or a fill. Live orders use real funds and must be independently tested with paper data first.

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

The daemon exposes loopback-only `/livez`, `/healthz`, `/readyz`, and `/status` endpoints on port 8788. `/livez` is process liveness; `/healthz` and `/readyz` report current trading readiness. It latches a stale-data halt after 90 seconds without fresh streaming data and clears only that latch after three distinct healthy oracle/book observations with at least one fresh market and markable open positions. Recovery checks shared stream health; each candidate still needs its own exact Polymarket oracle reference, current price, and executable book, so markets missing any input remain on HOLD. Kill, daily-loss, and manual-pause latches remain independent. It validates the paper ledger on every cycle. Daily-loss limits halt new entries but do not force-close open positions. New paper entries require the market's verified Polymarket 60-second TWAP opening Price to Beat and a fresh current price from the matching oracle feed; a Coinbase spot/open estimate cannot substitute for that market's oracle. A missed opening observation keeps that market on HOLD through its window; the engine waits for an exact tick at the next market start rather than estimating from a nearby price. The Linux systemd unit, log rotation, restricted Hermes watchdog permissions, and host commands are in [`deploy/README.md`](deploy/README.md).

The $20 tier threshold is an eligibility floor, not a promise that the account can place an order. The paper sizing policy selects a tier from current liquidation equity, then applies the stricter of its tier caps and any operator caps. A $1 operator floor or exchange minimum never overrides maximum stake, exposure, reserve, liquidity, or cash limits. If the CLOB minimum share size is missing or the minimum executable cost is too risky for the account, the engine records a PASS. At exactly $20, MICRO's 4% exposure cap is $0.80, below the $1 paper minimum, so that balance cannot enter; higher balances may also PASS when venue share minimums exceed their risk caps. MICRO and SMALL accounts can go long periods without a trade. No strategy or setting guarantees a trade for a small balance.

The browser and headless daemon persist recently observed, verified opening ticks so a refresh or daemon restart can recover that exact market reference. If the process never observed the market's exact opening tick, it keeps the market on hold until a new window; it does not estimate the Price to Beat from a nearby tick.

| Liquidation equity | Profile | Maximum stake | Cash reserve | Maximum exposure | Minimum net edge |
| --- | --- | ---: | ---: | ---: | ---: |
| $20–49.99 | MICRO | 5% | 50% | 4% | 8% |
| $50–99.99 | SMALL | 4% | 40% | 4.5% | 7% |
| $100–249.99 | GROWTH | 3% | 35% | 5% | 6% |
| $250–999.99 | STANDARD | 2.5% | 30% | 5% | 5% |
| $1,000+ | LARGE | 2% | 25% | 5% | 4% |

These percentages are policy ceilings, not target allocations. The sizing code can recommend less or PASS based on fees, slippage, uncertainty, available ask depth, price region, correlated crypto exposure, daily loss, or recovery state.

For an interactive terminal monitor, start the daemon in one terminal and run `pnpm run dashboard` in another. The monitor clock, countdowns, and display refresh every second with account cash/equity/P&L, open positions, recent fills and closed trades, current signals, feed freshness, and halt state. The daemon runs an independent one-second decision loop against its current cached and streaming data; REST market discovery, candles, and books refresh in the background every 15 seconds. Status reports the actual last decision duration and how many cycles exceeded the target. Press `q` to exit the monitor without stopping the daemon or `r` to refresh immediately. If it reports that the endpoint is unreachable, start `pnpm run daemon` in a separate terminal. It reads the daemon's loopback-only status endpoint and does not place orders.

Paper mode requires no API keys or wallet credentials. Keep any future live credentials in host-only secret storage; this daemon has no live executor, and the dashboard's browser-authenticated live routes are not part of this service.

## Multi-bankroll research replay

Replay the **same recorded market-decision CSV** through $20, $25, $50, $75, $100, $250, $500, $1,000, $2,500, $5,000, and $10,000 paper accounts:

```bash
pnpm exec tsx scripts/backtest-bankrolls.ts recorded-market-history.csv
```

The CSV needs timestamps, market IDs, duration, an explicit matching `model_version`, recorded model action and P(UP), remaining time, asks, bids, ask depth, and the CLOB minimum share size or cost. Bid depth is needed for usable liquidation marks. Outcomes and resolution times are needed for settled return and calibration metrics. Use `--help` for optional fee/slippage and explicit research assumptions. Missing bid, depth, minimum, probability, model decision, or matching model version causes the row to be excluded or PASS; missing outcomes leave result fields unavailable. The repository does not ship a candidate/order-book history sufficient to establish historical profitability. A paper fill ledger alone cannot reconstruct missed candidates or executable books.

The replay reports bankroll-specific trades, returns when settled, fees, slippage assumptions, exposure, minimum-order rejections, and probability buckets. When ask-level snapshots are present, it walks those levels separately for each bankroll and resizes against the resulting VWAP. Rows without a ladder use a fixed recorded entry price or the top ask plus configured slippage, so their price impact cannot be inferred. Liquidation equity uses each recorded top bid and bid depth with the flat exit-fee approximation; missing executable bid depth is valued at zero. Sparse rows cannot reproduce a full order-book exit or continuous intramarket drawdown. Its walk-forward probability adjustment waits for at least 200 previously resolved markets overall and 30 in the matching confidence bucket. Do not treat this replay as proof of live readiness.

## Interactive terminal live trader

The standalone `pnpm run live` command connects to the real Polymarket CLOB. It prompts for the wallet address and signature type, masks the private-key input, reads collateral/open orders/positions, then requires the exact word `YES` before scanning or placing anything. The key is kept in process memory and is not written to the trader state file. Use a trusted local terminal; never paste the key into chat, source control, command-line arguments, or an environment variable.

```powershell
pnpm install
pnpm run live
```

The trader uses LOCK signals, a 4% minimum displayed net edge, FAK limit orders, a $1 micro-account unit up to $100 balance, a $5 maximum order, and a 10% total-exposure cap. It stops if an order result cannot be reconciled and writes a pending marker so restart cannot silently submit a duplicate. Press `Q` then Enter to stop. Live orders use real funds, can partially fill, and the uncalibrated model does not establish profitability; run paper history and independently reconcile every wallet/order assumption before opting in.

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
