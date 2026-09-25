# Risk controls

## Paper (browser and daemon)

- Bankroll tiers set the stake, cash reserve, exposure, open-position limit, minimum net edge, spread, and expected-profit floors.
- The daily-loss halt rolls at UTC midnight. The drawdown peak persists across days.
- Stale data halts entries. Books older than 10 s (server time) never price a decision, and a drifted streamed book is unusable until repaired.
- Paper entries are FAK limit orders filled after a simulated latency. A pending paper order is persisted and cancelled on restart.
- Kill switch, pause, and stale-data latches are all available.

## Live (terminal trader only)

- **Single executor:** the web routes refuse order submission.
- **Order journal:**
  - Every order is written as SUBMITTING before it is posted. If the process dies there, a restart halts for manual reconciliation.
  - With an order ID, the order is SETTLING. No other order is placed until every trade is CONFIRMED or FAILED and the wallet shows the confirmed quantity.
  - Unexpected wallet movement, or 10 minutes without reconciling, halts the trader.
- **Complete wallet:** every page is read, including dust and archived positions. An incomplete page, an unvalued open position, or any combo position blocks entries. Resolved positions carry no exposure; redeem them on polymarket.com.
- **Equity:** liquidation equity marks open positions against executable bids after fees, and unmarkable positions count as zero. The wallet and marks refresh every 3 s whether or not exits are enabled.
- **Collateral:** balances are converted from raw six-decimal units unconditionally.
- **Prices:** FAK limits sit at most 2 ticks, and never more than $0.02, past the observed price, and never above the model ceiling. Exits are judged on the worst proceeds the posted limit allows.
- **Exits:** fixed take-profit and stop-loss are off by default. When on, they only sell if the model does not value holding above the sale.
- **Startup checks:** the trader refuses to arm when no entry can pass at the current balance, and reports whether the model weight is fitted or the prior.

Live trading stays a manual, supervised decision. Nothing here demonstrates profitability.
