# Architecture

The dashboard is a client-side paper terminal with an intentionally explicit live boundary.

    Market discovery -> book/reference snapshots -> probability model
                                                  -> cost-aware edge
                                                  -> risk gates
                                                  -> paper execution
                                                  -> positions / P&L / audit feed

The next production slice should split the engine into:

- market-discovery: current/upcoming market parsing from Gamma metadata.
- market-data: reconnecting CLOB market stream, RTDS/reference feed, and redundant spot feeds.
- strategy: calibrated short-horizon probability and microstructure features.
- execution: idempotent order state machine and REST/WebSocket reconciliation.
- risk: fractional-Kelly cap, exposure limits, loss halts, stale-data gates, and kill switch.
- ledger: fills, fees, positions, realized/unrealized P&L, and restart recovery.
- dashboard: read-only stream of sanitized state plus deliberate control commands.

Private signing belongs in the server-side execution process. The browser should receive sanitized market, signal, risk, and account state only.
