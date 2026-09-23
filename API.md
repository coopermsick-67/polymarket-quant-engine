# API

All routes return JSON with `Cache-Control: no-store`.

## `GET /api/polymarket/reference?keys=BTC:5m:1790128200000,...`

Proxy for Polymarket's official price endpoint (`polymarket.com/api/crypto/crypto-price`), which sends no CORS headers. Up to 60 keys of the form `ASSET:5m|15m:startMs`; starts must be minute-aligned and within the last 6 hours. Returns `{ ok, prices: { key: { openPrice, closePrice, completed, fetchedAt } } }`. Open prices are cached for the isolate's lifetime.

## `POST /api/polymarket/live`

Owner-gated (signed-in owner, or loopback with `POLYMARKET_LIVE_ALLOW_LOCALHOST=true`). Body validated with zod.

| action | Notes |
| --- | --- |
| `status` | `{ serverKeyConfigured }` |
| `connect` | `{ useServerKey: true }` uses `POLYMARKET_PRIVATE_KEY`/`POLYMARKET_WALLET_ADDRESS`; otherwise `{ walletAddress, privateKey, signatureType }`. Derives CLOB credentials and sets a sealed 15-minute session cookie. |
| `balance`, `positions` | Read-only. Positions come from the Data API and are parsed with the window end derived from the slug. |
| `execute` | Requires `confirmLive: true` and header `x-polymarket-live-confirm: 1`. Body: `{ marketId, side, requestId, config, feed }` where `feed` is `{ clientNow, spot, spotTimestamp, spotSource, basisBps, sigmaPerSqrtSecond, volSamples, ticks[] }`. The server re-evaluates the signal on its own books and reference, sizes with Kelly, checks portfolio limits and the daily stop, and posts a FAK order with a limit price. |
| `exit` | Same confirmation. `{ marketId, tokenID, amount, feed, config }`; sells only if `evaluateExit` approves, with a limit floor. |
| `cancel-all` | Same confirmation. |
| `disconnect` | Clears the session cookie. |

Responses: `EXECUTED`, `REJECTED`, `PASS` (with `reason`), `COOLDOWN`, or `{ ok: false, uncertain: true }` when a submission outcome is unknown.

## `POST /api/polymarket/account`

`{ walletAddress }` only. Public Data API reads; authenticated balance, orders and trades only when the caller's own live session matches the wallet. Private keys and API secrets are not accepted in this body.

## `POST /api/telegram`

Owner-gated. `connect { botToken, chatId }`, `status`, `send-report { text }`, `disconnect`. The bot token is sealed in an HttpOnly cookie, never stored in the browser.
