# Risk controls

Nothing here guarantees a profit. These controls bound losses and stop the engine from trading on bad data.

## Data-quality gates (every entry, paper and live)

| Gate | Blocks an entry when |
| --- | --- |
| `REFERENCE` | The official price to beat (the Chainlink stream print at the window start) is not known. Estimated references are never traded by default. |
| `SPOT` / `STALE_SPOT` | No price feed, or the exchange tick is older than 4 s. |
| `UNANCHORED` | Exchange ticks are not anchored to the Chainlink stream. Unanchored feeds carry a several-bp basis error, larger than a minute of BTC volatility. |
| `DIVERGENCE` | Stream-vs-exchange basis exceeds 30 bp (feed fault). |
| `VOLATILITY` / `WARMUP` | No volatility estimate, or fewer than 300 one-second returns behind it. |
| `TIME` | Less than 15 s remain. |
| `STALE_BOOK` | The order book is older than 15 s. |
| `EDGE` | No side clears the edge floor after slippage and the fee curve, using the worst case over a ±30% volatility band, a 2% resolution-noise allowance, and a blend with the book. |
| `TAIL` | The fill would be below 5¢ (no lottery tickets). |
| `SPREAD` | The chosen side's spread exceeds 6¢. |

## Execution

- Every live order is fill-and-kill with a **limit price**: the highest tick at which the all-in cost still leaves the required edge. Sells use a floor at fair value plus the exit gap.
- Order submissions are never retried. A lost response is reported as "uncertain" and stops the live runner until the account is reconciled.
- The live server rebuilds the market itself (Gamma, CLOB, official price) and treats the browser's price feed only as a claim, rejecting it if it disagrees with the server's own exchange read by more than 60 bp.

## Sizing and portfolio (live, enforced server-side)

- Fractional Kelly on the all-in cost per share, capped by unit size, max trade, 50% of depth under the limit, and balance.
- One position per market. Total open cost basis ≤ 20% of equity. At most 2 positions settling in the same window on the same side (crypto assets are highly correlated).
- Daily loss stop at 5% of the trading-day (America/New_York) opening equity, persisted in a sealed cookie.
- At most 6 orders per minute; duplicate request ids are refused.
- Asset allow-list (default BTC, ETH, SOL, XRP) and duration filter.
- Collateral balances are parsed as integer micro-USDC; there is no magnitude guessing.

## Paper engine

- Separate daily-loss (5%) and peak-to-trough drawdown (15%) halts; a halt clears queued orders and stays until acknowledged.
- Fills are simulated after the configured latency at the decision's limit price against the book that exists then.
- Positions settle only on official Polymarket resolutions. A closed window's emptied book never marks a position to zero.

## Operational

- WebSocket watchdogs reconnect a silent order-book stream (30 s) or a silent Chainlink stream (15 s); book deltas that disagree with the server's reported top of book trigger a REST resync.
- The headless runner persists state atomically and saves before exiting on an uncaught error; the supervisor restarts it.
- Kill switches: paper (clears queue, halts), live (stops the runner and sends cancel-all).
