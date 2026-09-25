# Architecture

Three processes share one set of library modules in `app/lib/`:

| Process | Entry point | Places real orders? |
| --- | --- | --- |
| Browser terminal (paper, account view) | `app/page.tsx` + `app/api/*` routes | No. The web routes refuse order submission. |
| Headless paper daemon | `scripts/trading-daemon.ts` | No. Paper only; refuses `TRADING_MODE=live`. |
| Terminal live trader | `scripts/live-trader.ts` | Yes. The single live executor. |

    Gamma discovery -> CLOB books (stream + REST snapshots) -> oracle feeds (RTDS)
        -> settlement forecast (Chainlink spot + observed TWAP window)
        -> anchoring to the book (fitted stacking weights, or a conservative prior)
        -> cost-aware edge (per-market CLOB fee curve, depth walk)
        -> bankroll and risk gates
        -> paper fill (FAK after simulated latency) | live FAK order (journaled)
        -> settlement / reconciliation -> ledger and status

## Modules

- `polymarket-data.ts`: market discovery, books, oracle ticks, server-clock sync, the TWAP settlement forecast, and anchoring. Every book timestamp is in Polymarket server time.
- `clob-book-stream.ts`: the market-channel parser and applier. Each price change is checked against the venue's top of book; drifted books are invalidated until a snapshot repairs them. Quiet books need token-specific evidence or a REST refresh.
- `engines.ts`: signal, paper execution, settlement, and the decision replay.
- `model-calibration.ts`: the versioned stacking fit with a chronological holdout, and the decision-evidence report.
- `wallet-positions.ts`: complete wallet inventory (cursor pages, dust, archived, redeemable, combo refusal).
- `live-order-journal.ts`: the live order state machine (SUBMITTING, then SETTLING until trades are terminal and the wallet agrees).
- `live-order-pricing.ts`: model price ceilings, FAK limits with capped tolerance, worst-case sell proceeds, and bid-depth liquidation value.
- `bankroll-policy.ts`, `live-bankroll-policy.ts`, `live-risk.ts`, `live-risk-baselines.ts`: sizing tiers, the coherent live profile, and drawdown baselines.
- `request-guards.ts`: body limits, same-origin checks, rate limits, and read coalescing for the Worker routes.

## Boundaries

- Signing happens only in the terminal trader, from a key typed at a hidden prompt. The web routes accept a raw key only on a loopback-bound local server (`POLYMARKET_LIVE_ALLOW_LOCALHOST=true`, not `POLYMARKET_HOSTED=true`), and even then they only read state and cancel orders.
- The browser receives market, signal, risk, and account state. A hosted page never builds a request containing a key.
