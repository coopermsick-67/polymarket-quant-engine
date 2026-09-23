# Strategy

## What the contract actually settles on (measured, not assumed)

Gamma describes these markets as settling on a Chainlink **TWAP** (`cryptoMarketConfig: { twapEnabled: true, twapLookbackSeconds: 60 }`). The published prices say otherwise. Captured live on 2026-09-23 (`tests/fixtures/settlement-verification.json`):

- The official `openPrice` and `closePrice` (polymarket.com `crypto-price`) equal the Chainlink print on Polymarket RTDS (`crypto_prices_chainlink`) **at** the boundary to 0.00bp, for every asset checked. They differ from a 60 s average by up to 5bp.
- A window's `closePrice` equals the next window's `openPrice`.
- The RTDS Chainlink print tracks the **instantaneous** exchange price with about 1 s of lag (BTC residual 0.49bp against the point price vs 1.35bp against a 60 s average).
- `closePrice >= openPrice` reproduced 54 of 56 official outcomes. A 60 s end-TWAP rule did worse (53/56). The two misses are not explained by either rule.

So the engine models a **point** settlement: `P(UP) = P(S_T ≥ K)` where `K` is the official open and `S` is the Chainlink stream. The two unexplained outcomes are carried as a 2% resolution-noise term that keeps the engine from paying 99¢ for "certainties". The averaged-window math is kept in `pricing.ts` (and tested) in case the published prices ever start reflecting the TWAP.

## Fair value

```
S_now      = exchange_now + basis          basis = median(stream(t) − exchange(t − 1 s)) over the last minute
σ          = EWMA of 1 s exchange returns, blended with Garman-Klass 5m candles on a cold start
P(UP)      = Φ( ln(S_now / K) / (σ √τ) )   evaluated at σ·0.7, σ, σ·1.3; the worst case for each side is used
P_noisy    = ε + (1 − 2ε) · P(UP)          ε = resolution noise (0.02)
posterior  = logistic( w · logit(P_noisy) + (1 − w) · logit(book mid) )   w = model weight (0.5)
```

Entry cost is the depth-walked average price plus slippage plus the fee curve `rate × (p(1 − p))^exponent` per share from each market's `feeSchedule` (matches the official client's `adjustBuyAmountForFees`; 1.75¢/share at 50¢ under rate 0.07, exponent 1). The order's limit is the highest tick at which the worst-case posterior still beats the all-in cost by the edge floor.

## Where edge can come from (and where it cannot)

- **Speed and anchoring.** Exchange prints lead the Chainlink stream by about 1 s, and a book quoting from a slower or unanchored price is stale. This is the edge the replay tests demonstrate against a lagging book.
- **Better volatility** than the book implies, especially around regime changes.
- **Not** from chart patterns. EMA/RSI/candle indicators are shown for context only; they were a hand-tuned +7.5pt nudge in the old engine and never earned a place in fair value.
- **Not** from disagreeing with the book for its own sake. Against a fairly priced book the engine makes zero trades after fees (tested).

## Evidence so far

- Simulated: against a book quoting the right model on a 20 s-old price, 400 markets → 199 fills, +10pt realized edge, positive 5 s markouts. Against a fair book → 0 trades.
- Live paper runs on 2026-09-23 found and fixed six defects: marks to zero on emptied books, a false halt, Gamma's 20-row default page, a WebSocket error recursion, stream-silence handling, and startup trades before volatility had warmed up. The first two runs lost money; the trades were few, taken during warm-up, and partly on the wrong (TWAP) model. They are not evidence of edge in either direction.
- On 62 real checkpoints, the raw model's Brier score (0.1026) was slightly worse than the book's (0.0998), while the model-plus-book posterior (0.0950) beat both. That is the case for trading the posterior, not the raw model.

**Status: unproven.** Record with the headless runner for days, then run `pnpm run replay -- data/*.jsonl --walk-forward`. Promote to live only if, out of sample, realized edge is positive with a confidence interval excluding zero, the posterior's Brier score beats the book's, and 5 s markouts are non-negative.

## Not built

Maker quoting (the fee schedule is taker-only with a 20% rebate share), cross-duration consistency (a 15m window contains three 5m windows), and cross-asset lead-lag are the next strategies to research; the recorder already captures the data they need.
