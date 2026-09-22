# Strategy notes

The live paper-entry signal uses a chart filter followed by an execution-cost filter:

    chart direction = EMA trend + recent log returns + RSI + candle bodies + relative volume
    confluence      = target-duration trend agrees with the other timeframe
    fair probability = normal-CDF estimate from spot/reference distance and recent realized volatility,
                       adjusted modestly by the combined chart score
    net edge         = fair probability - depth-walked ask including configured fees and slippage

Coinbase 5m and 15m OHLC history is cached for one minute and the active candles are updated from the Coinbase ticker stream. Both charts need at least 24 complete candles. When Gamma does not provide the market opening reference, the matching Coinbase 5m candle open is labeled as an estimate; it is only a proxy because these markets resolve against Chainlink. Estimated references require extra edge, lose confidence, and can never receive a LOCK tier. Missing or stale history, missing references, conflicting trends, weak model confidence, wide books, and insufficient net edge all produce PASS. A LOCK requires stricter confidence, edge, and two-timeframe thresholds; it is not a promise of a winning trade.

The UI exposes components that should be learned and validated from timestamped historical or recorded paper data:

- distance from the market reference price;
- remaining time and realized short-horizon volatility;
- momentum and acceleration;
- market-book imbalance and microprice;
- quote velocity and liquidity;
- cross-duration context;
- execution quality and stale-data risk.

The current CSV backtest does not include OHLC indicators, so its metrics do not measure the live chart-signal algorithm.

Do not promote a strategy to live based on a small sample, in-sample tuning, headline win rate, or a single market regime. Require walk-forward or out-of-sample calibration, Brier/log-loss reporting, net-of-cost results, and a minimum sample size.
