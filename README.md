# Polymarket Quant Engine

Polymarket Quant Engine is a dark, paper-first trading terminal for short-duration crypto Up/Down markets. It puts market discovery, probability signals, cost-aware edge, paper positions, P&L, audit events, risk settings, and an emergency stop in one working surface.

## What is included

- Public Gamma discovery for active crypto 5m/15m markets, public CLOB order books, and public Coinbase spot prices.
- No synthetic market, quote, position, P&L, or equity fallback: missing data renders as unavailable and blocks the related action.
- Paper start/pause, manual paper buys, public-ask book walking, cash checks, minimum-order checks, close-positions, and an emergency kill switch.
- Cost-aware heuristic signal panel with transparent reference/spot inputs, order-book depth, spread, edge, and no-trade guards.
- Editable minimum edge, max trade, fee, slippage, and daily-loss guardrails.
- Equity curve, open positions, paper P&L, fees, drawdown, win rate, and browser-local audit events.
- A backtest lab that accepts a user CSV or public ticks recorded by the app, with settled/unsettled separation and no fabricated results.
- A deliberate live-mode gate that keeps live activation blocked until a server-side credential, balance, stream, risk, and reconciliation adapter is installed.

The browser never receives a wallet private key or CLOB secret. The current published build is paper mode; it does not submit live orders or claim profitable performance.

## Run locally

    pnpm install
    pnpm run dev

For a production-style build:

    pnpm run build
    pnpm run start

The managed Sites preview uses sites-preview start and http://terminal.local:4173/.

## Live integration boundary

The official Polymarket docs currently describe Gamma for public market metadata, CLOB for books and orders, Data API for positions/activity, Relayer for wallet transactions, and separate public market and authenticated user WebSocket channels. CLOB authentication uses wallet-signed L1 setup plus API-credential L2 request signing.

Before enabling live trading, implement a server-side adapter that:

1. Discovers and validates markets from official metadata.
2. Maintains public books and reference-price streams.
3. Uses the official SDK or exact current API signing flow.
4. Reconciles orders, fills, positions, balances, and P&L on restart.
5. Fails closed on stale data, uncertain order state, missing credentials, or risk-halt conditions.

See SETUP.md, ARCHITECTURE.md, STRATEGY.md, RISK.md, and API.md.

## Safety

This application is a research and paper-execution surface, not a promise of returns. A positive displayed edge is not evidence of a profitable strategy. Do not fund live trading until out-of-sample calibration, fill simulation, fees, slippage, reconciliation, and risk limits have been independently verified.
