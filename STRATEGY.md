# Strategy notes

The displayed paper signal is deliberately conservative and cost-aware:

    net edge = calibrated fair probability
             - executable ask
             - spread/slippage estimate
             - fee estimate
             - volatility/uncertainty buffer

The UI exposes components that should be learned and validated from timestamped historical or recorded paper data:

- distance from the market reference price;
- remaining time and realized short-horizon volatility;
- momentum and acceleration;
- market-book imbalance and microprice;
- quote velocity and liquidity;
- cross-duration context;
- execution quality and stale-data risk.

Do not promote a strategy to live based on a small sample, in-sample tuning, headline win rate, or a single market regime. Require walk-forward or out-of-sample calibration, Brier/log-loss reporting, net-of-cost results, and a minimum sample size.
