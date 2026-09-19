# Risk controls

The dashboard defaults to paper mode and includes:

- minimum net-edge threshold;
- maximum paper trade size;
- daily-loss halt;
- minimum confidence threshold;
- no-trade behavior when the edge is below costs;
- no martingale or loss doubling;
- fractional Kelly sizing target capped at 0.10x for the research configuration;
- stale data and uncertain execution as hard stop conditions;
- separate cancel-orders and close-positions actions;
- emergency kill switch that halts new strategy execution and clears the paper order queue.

Live mode must remain unavailable until the backend verifies credentials, account resolution, funds, market/user streams, risk settings, and reconciliation state. A frontend boolean must never be enough to activate live orders.
