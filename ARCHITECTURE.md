# Architecture

One engine, three hosts: the browser dashboard, the headless Node runner, and the replay backtester all run the same modules. There is no second implementation of pricing, gating, or fills to drift out of sync.

```
                 ┌──────────────────────── app/lib/market-feed.ts (MarketFeedController) ───────────────────────┐
 Gamma REST ───▶ │ discovery (cryptoMarketConfig, feeSchedule, tick, min size) · official resolutions            │
 CLOB REST+WS ─▶ │ order books; price_change deltas checked against server best bid/ask, resynced on drift      │
 RTDS WS ──────▶ │ Chainlink settlement stream + Binance prices; stream-silence watchdog                        │
 Coinbase WS ──▶ │ underlying ticks                                                                              │
 crypto-price ─▶ │ official price to beat (openPrice) via /api/polymarket/reference or directly in Node          │
                 └──────────────┬───────────────────────────────────────────────────────────────────────────────┘
                                │ LiveMarket (books, reference, fees)   DerivedFeed per asset (feeds.ts)
                                ▼
            polymarket-data.ts: snapshotFromLiveMarket ──▶ MarketSnapshot (pure data, JSON-serializable)
                                ▼
            signal.ts: evaluateSignal(snapshot, params)            ◀── the single decision function
              gates → pricing.ts fairValue (settlement distribution, vol band) → shrink to book → fee-curve fill
              → limit price that preserves the edge → side choice
                                ▼
     ┌───────────────────────────┬──────────────────────────────┬──────────────────────────────┐
     │ paper-engine.ts           │ api/polymarket/live/route.ts │ replay.ts                    │
     │ latency-delayed limit     │ server rebuilds the market,  │ recorded snapshots, latency, │
     │ fills, official settle,   │ Kelly + portfolio limits,    │ depth-limited fills,         │
     │ halts, exits              │ FAK limit order, no retries  │ calibration vs the book      │
     └───────────────────────────┴──────────────────────────────┴──────────────────────────────┘
       used by app/page.tsx and scripts/headless.ts        scripts/replay.ts, Research tab
```

## Modules

| File | Responsibility |
| --- | --- |
| `app/lib/num.ts` | Shared numeric/parsing helpers (normal CDF, Wilson interval, tick rounding, base64url). |
| `app/lib/pricing.ts` | Settlement distribution (point or averaged window), `P(UP)`, volatility-band robustness, Polymarket fee curve, EWMA and Garman-Klass volatility, market shrinkage. |
| `app/lib/feeds.ts` | Tick buffers and the underlying series anchored to the Chainlink stream (median basis against exchange ticks lagged 1 s). |
| `app/lib/signal.ts` | `evaluateSignal`, `evaluateExit`, depth- and fee-aware buy/sell simulation, limit-price solver. |
| `app/lib/polymarket-data.ts` | Zod-validated Gamma/CLOB/official-price parsing, discovery, books, resolutions, LiveMarket assembly. |
| `app/lib/market-feed.ts` | `MarketFeedController`: REST refresh, three WebSockets with backoff and watchdogs, book integrity resyncs, reference capture, resolution polling, 250 ms batched change notifications. |
| `app/lib/engines.ts` | Paper account: fills, depth-walked exits, official-only settlement, daily and drawdown halts, exposure checks. |
| `app/lib/paper-engine.ts` | One paper/shadow step: settle, fill due orders at their limits, halts, confirmed exits, queue one new order. |
| `app/lib/replay.ts` | Replay backtester, walk-forward split, calibration and reliability, JSONL/CSV import. |
| `app/lib/live-risk.ts` | Live Kelly sizing, balance parsing, Data API position parsing, portfolio risk checks. |
| `app/lib/decision-ledger.ts` | Per-market ledger graded on the first entry, with a fixed 120 s calibration checkpoint. |
| `app/api/polymarket/*` | `live` (orders), `account` (read-only account data), `reference` (official price proxy). |
| `scripts/headless.ts` | 24/7 paper/shadow runner with atomic state persistence, JSONL recording and Telegram alerts. |
| `scripts/replay.ts` | CLI replay and walk-forward over recordings; backfills outcomes from Gamma. |

## State and persistence

- Browser: paper account, config, and ledger in `localStorage` (per-viewer conveniences). Recording kept in memory and exportable as JSONL.
- Headless: `data/paper-state.json` (atomic rename), `data/events-*.jsonl`, `data/replay-*.jsonl`.
- Live: nothing trusted is stored client-side. The session (CLOB credentials, and the key only if browser-linked) is an AES-GCM sealed HttpOnly SameSite=Strict cookie; the day's starting equity and recent order ids are a second sealed cookie. The exchange position list is the source of truth for duplicate protection.
