# Strategy notes

## Forecast

Crypto Up/Down markets settle on whether the 60-second Chainlink TWAP at expiry is at or above the TWAP at the start (the price to beat). The forecast starts from Chainlink spot, because the TWAP lags spot by about half its window:

- **More than 60 s left:** the whole averaging window is in the future. The average of a Brownian path over it has variance σ²(τ − 40) around current spot.
- **60 s or less left:** the observed part of the window is locked in, averaged from spot ticks. Each tick is held for at most 3 s, and at least 80% of the elapsed window must be covered. The future part adds variance σ²·spot²·τ³/3.

σ and a small drift come from the market's own horizon candles.

## From forecast to edge

- **Anchoring:** the raw forecast is combined with the book mid in log-odds. `pnpm run calibrate` fits `logit P = a + b_model·logit(model) + b_market·logit(mid)` on settled observations of the current model version. Until a fit passes every gate (300+ markets, a positive time-block lower bound on `b_model`, and beating the book on the most recent 30% of markets), a conservative prior gives the model a quarter of the weight.
- **Edge:** the anchored probability minus the depth-walked ask, including each market's CLOB taker fee (`rate × p × (1 − p)`) and a slippage buffer.
- **Gates:** freshness, a model/market gap cap, the trend filter, price and spread limits, the net-edge floor, and the bankroll tier gates.

## Evidence

A better calibration fit shows the model carries information. It is not a net-of-fee trading edge. The daemon records every usable market's decision, including PASS, with its fee schedule and model version. `pnpm run calibrate` reports the first recorded entry per settled market, comparing claimed edge with realized edge per share, with a time-block 95% interval. Only a positive lower bound there, over many markets and a pre-registered chronological cohort, supports going live.

The CSV replay trades only rows with an explicit recorded decision and probability. It recomputes edge from the simulated fill and each row's fee rate, and settles at market expiry. Its drawdown is settlement-basis, not intramarket liquidation.
