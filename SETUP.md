# Setup

Requirements: Node.js 22.13+ and pnpm 11.25.0 (`corepack enable && corepack prepare pnpm@11.25.0 --activate`).

```bash
pnpm install
pnpm run check        # typecheck + lint + prettier + tests
pnpm run dev          # dashboard
pnpm run headless:supervised           # paper/shadow engine, SQLite recorder, heartbeat watchdog
pnpm run runner:status                 # check process heartbeat and core feed health
pnpm run backfill -- --data-dir data   # fill official outcomes and boundary prices into recordings
pnpm run report -- --data-dir data     # daily OOS calibration, edge/markout CIs, and gate status
pnpm run replay -- data/recordings/recording-YYYY-MM-DD.sqlite.gz --walk-forward
pnpm exec playwright install chromium  # once, for the browser smoke test
pnpm run test:e2e
```

The Playwright smoke test relays external HTTP requests through its Node-side fixture handler and stubs the market WebSockets. It verifies market cards render, the disabled live-evidence gates display, and the page raises no runtime errors without depending on public API availability.

## Environment (`.env.local`, never committed)

| Variable                                                                           | Purpose                                                                      |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `POLYMARKET_LIVE_SESSION_SECRET`                                                   | 64 hex chars. Seals live-session and daily-risk cookies. Required for live.  |
| `POLYMARKET_TELEGRAM_SESSION_SECRET`                                               | 64 hex chars. Seals the Telegram cookie.                                     |
| `POLYMARKET_LIVE_ALLOWED_USER_ID`                                                  | Owner id on hosted deployments.                                              |
| `POLYMARKET_LIVE_ALLOW_LOCALHOST`                                                  | `true` only on a trusted single-user machine; enables loopback owner access. |
| `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_WALLET_ADDRESS`, `POLYMARKET_SIGNATURE_TYPE` | Server-held signer (recommended). The key never reaches the browser.         |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`                                           | Alerts from the headless runner.                                             |

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Live order status: disabled

The API rejects new buys and sells with HTTP 423. Linking a wallet, viewing balances and positions, and cancelling open orders remain available. Do not set up this app to place real orders: the current measured strategy loses to the book and the CLOB order path has not passed integration or canary tests.

Keep the headless runner recording continuously. Data is stored under `data/recordings/` in daily SQLite databases; closed days are gzip-compressed. Backfill official market outcomes and prices with `pnpm run backfill -- --data-dir data`. Review `STRATEGY.md` for the current G1–G6 counts and results. All six gates are required before enabling any real-money mode; at least 7 days and 3,000 resolved markets are required before promoting B or C research.

Run `pnpm run report -- --data-dir data` nightly (for example, from the same host's scheduler). It writes Markdown and JSON to `data/reports/`, uses expanding daily walk-forward fits, clusters bootstrap intervals by market, and never treats dry-run/canary gates as passed. Telegram delivery uses `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` when configured.

## Unattended 24/7 paper recording (Linux)

The Node runner needs persistent local disk for SQLite and long-lived outbound WebSockets. Deploy it on an always-on Linux host; the Cloudflare dashboard deployment does not keep this Node process alive. The supervisor restarts a crashed process, checks `data/runner-heartbeat.json`, and terminates/restarts the child if heartbeat writes or one-second paper ticks stop for 30 seconds. Startup has a 90-second grace period, and repeated failures back off up to 30 seconds. The heartbeat includes feed connection state and age so a live process with disconnected feeds is visible as degraded.

The checked-in unit assumes the repository is at `/opt/polymarket-quant-engine`, the service account is `pqe`, and Node/Corepack/pnpm are on `/usr/local/bin:/usr/bin:/bin`. Adjust those paths to the host's installation. Then install and start it:

```bash
sudo useradd --system --create-home --home-dir /var/lib/pqe --shell /usr/sbin/nologin pqe
sudo install -d -o pqe -g pqe /opt/polymarket-quant-engine /var/lib/pqe
sudo cp deploy/systemd/pqe-paper.service deploy/systemd/pqe-nightly.service deploy/systemd/pqe-nightly.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pqe-paper.service pqe-nightly.timer
systemctl status pqe-paper.service
pnpm run runner:status -- --data-dir /var/lib/pqe
journalctl -u pqe-paper.service -f
```

Install the checkout and dependencies in `/opt/polymarket-quant-engine` before starting the service. Optional Telegram variables can be placed in `/etc/pqe-paper.env` with root-only permissions. This runner needs no Polymarket private key and never submits live orders. The nightly timer backfills official market data and writes evidence reports under `/var/lib/pqe/reports/`. A heartbeat only proves the local process loop is alive; it does not prove feed completeness, edge, or any evidence gate.
