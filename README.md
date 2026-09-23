# Polymarket Quant Engine

Pricing, paper/shadow trading, replay backtesting, and limit-priced live execution for Polymarket's 5-minute and 15-minute crypto Up/Down markets (BTC, ETH, SOL, XRP, DOGE, BNB, HYPE, ZEC).

**No strategy here is proven profitable.** The engine is built to find out honestly: every decision is recorded, graded on official outcomes, and scored against the order book's own probability. Read `STRATEGY.md` before risking money.

## What it does

- **Settlement-accurate pricing.** Uses the official price to beat and the Chainlink stream that markets settle on, verified live against Polymarket's published open/close prices (see `STRATEGY.md`). Exchange ticks are anchored to that stream, volatility comes from 1 s returns, and fair value is taken as the worst case over a volatility band, blended with the book.
- **Real costs.** Depth-walked fills, slippage, and each market's fee curve (`rate × (p(1 − p))^exponent`, matching the official client).
- **One decision function** (`evaluateSignal`) shared by the dashboard, the headless runner, the live order route, and the backtester.
- **Paper/shadow engine.** Decides now, fills after a simulated latency at the decision's limit price, settles only on official resolutions, and enforces daily-loss and drawdown halts.
- **Replay backtester.** Runs recorded sessions through the live code with latency and depth limits. Reports EV, realized vs predicted edge, markouts, Sharpe, Wilson intervals, calibration against the book, and a walk-forward split.
- **Live execution controls.** The server route has risk checks and fill-and-kill order construction, but order submissions are hard-disabled until the evidence and execution gates in `STRATEGY.md` pass. No real order path has passed CLOB integration testing.
- **24/7 headless runner.** No browser tab needed. Persists paper state atomically, records daily SQLite files with raw exchange and Polymarket messages, snapshots, decisions, fills and settlement data, and sends Telegram alerts.

## Quick start

```bash
corepack enable && corepack prepare pnpm@11.25.0 --activate
pnpm install
pnpm run check                               # typecheck, lint, prettier, 81 tests
pnpm run dev                                 # dashboard
pnpm run headless -- --auto                  # paper engine + daily SQLite recorder, no browser
pnpm run backfill -- --data-dir data         # official outcomes and open/close prices
pnpm run report -- --data-dir data           # walk-forward report, CIs, gates, optional Telegram
pnpm run replay -- data/recordings/recording-*.sqlite* --walk-forward
```

Supervised 24/7: `bash scripts/run_forever.sh headless` (or `scripts/run_forever.ps1 headless` on Windows).

## Documentation

- `STRATEGY.md`: the settlement evidence, the model, where edge can and cannot come from, and current evidence.
- `RISK.md`: every gate and limit.
- `ARCHITECTURE.md`: modules and data flow.
- `API.md`: server routes.
- `SETUP.md`: environment variables and the evidence checklist; live orders are disabled until every required gate passes.

Never commit keys or tokens. `.env*` and `data/` are git-ignored.
