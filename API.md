# API integration contract

The eventual server adapter should expose sanitized endpoints or a server-sent stream for:

- connection and data freshness status;
- eligible market metadata and token IDs;
- order-book snapshots and reference prices;
- model probabilities, confidence, edge, costs, and no-trade reasons;
- account balances, positions, open orders, fees, and realized/unrealized P&L;
- audit events and risk-halt state;
- deliberate controls: start, pause, cancel orders, close positions, and kill switch.

Never expose signer keys, wallet private keys, CLOB secrets, passphrases, or raw authenticated headers. Every order command should be authorized server-side, idempotent where possible, and reconciled before retrying a timed-out request.

The current UI intentionally uses a local paper state engine and does not claim that these endpoints already exist.
