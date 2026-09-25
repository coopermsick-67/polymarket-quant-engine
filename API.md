# API routes

All routes are `POST` with a JSON body (`Content-Type: application/json`, small body limits). Browser requests must be same-origin.

## `/api/polymarket/account`

Reads a wallet's public value, positions, activity, P&L, and stats from the Data API. It also reads the authenticated collateral balance, open orders, and trades when CLOB API credentials or a local live session are present. Public reads are rate-limited per client and per wallet, cached for 15 seconds, and capped in concurrency. A raw private key is refused unless the request comes from a loopback-bound local server.

## `/api/polymarket/live`

| Action | Behavior |
| --- | --- |
| `connect` | Local only. Derives CLOB credentials from the key and seals a 15-minute encrypted session cookie. |
| `balance`, `positions` | Read the linked wallet. Resolved positions are returned separately as `redeemablePositions`. |
| `cancel-all` | Cancels open orders (explicit confirmation header required). |
| `disconnect` | Clears the session. |
| `execute`, `manual-entry`, `exit`, `manual-exit` | Refused with `410 TERMINAL_ONLY`. |

Order submission lives only in the terminal trader. A serverless route cannot keep a durable per-wallet order journal or a cross-instance lock, and an accepted FAK is not proof of a fill.

## `/api/telegram`

Links a bot for paper-test reports and sends messages. It requires same-origin JSON, and sends are rate-limited.

## Headless daemon (loopback, port 8788)

`GET /livez`, `/healthz`, `/readyz`, `/status`: process liveness, trading readiness, and a sanitized status snapshot. Browser reads must come from an origin listed in `PQE_DASHBOARD_ORIGINS`.

Never expose signer keys, CLOB secrets, passphrases, or raw authenticated headers through any of these.
