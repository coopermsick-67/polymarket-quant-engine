# Hostinger VPS: 24/7 paper trading setup

This guide deploys the repository's headless, **paper-only** trading daemon on an Ubuntu VPS. The trading engine deterministically reads public Polymarket/Coinbase data, checks risk and reconciliation rules, and records a local simulated ledger. systemd keeps it running. Hermes is an optional, low-usage operator for alerts and on-demand commands; it does not choose trades or manage live orders.

The VPS is not created automatically by this repo. Never send passwords, API keys, or wallet secrets in chat or commit them to GitHub. This daemon does not need trading credentials.

## Recommended low-cost host

For this workload, a small Ubuntu 24.04 VPS is sufficient. Confirm current capacity, price, billing term, and region before purchasing. See [Hostinger VPS plans](https://www.hostinger.com/vps-hosting).

Any ordinary x86-64 Ubuntu 24.04 VPS with at least 2 GB RAM should run the paper daemon; 4 GB is preferable if you also install Hermes. The instructions below also work on another provider if it gives you root/sudo access and an Ubuntu 24.04 image. Do not choose shared website/PHP hosting: the worker needs a persistent Linux process and systemd.

## 1. Put the reviewed code in your GitHub repository

Review the current checkout, commit the deployment changes, and push the branch that the VPS will clone. From Windows PowerShell:

```powershell
cd C:\path\to\polymarket-quant-engine
git status --short
git diff --check
git add README.md deploy app scripts package.json pnpm-lock.yaml
git commit -m "Update bankroll-aware paper daemon"
git push -u origin HEAD
```

Wait for the push to finish, then open the repository on GitHub and confirm it contains `scripts/trading-daemon.ts` and `deploy/install-host.sh`. If the reviewed commit is already on your GitHub branch, skip this step. The repository is public and can be cloned over HTTPS without a deploy key.

## 2. Create the Hostinger VPS

In Hostinger hPanel:

1. Choose **VPS → KVM 1** and select **Ubuntu 24.04**. Choose a region with reliable access to Polymarket and Coinbase public APIs.
2. Add an SSH public key during setup if offered. On your Windows computer, create a key with `ssh-keygen -t ed25519 -C "pqe-hostinger"`, then display the public key with `Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub`. Add only the `.pub` contents under the VPS **Settings → SSH keys** page. Keep the private key on your computer.
3. In the provider firewall, allow inbound SSH (normally TCP 22). Restrict it to your current public IP if practical. Do not open ports 8787 or 8788.
4. Wait for the VPS to finish installing. In the VPS overview, note its IP and the SSH username. Hostinger offers a browser-based Web Console as an alternative to SSH; see [Hostinger's SSH connection guide](https://www.hostinger.com/support/5723772-how-to-connect-to-your-vps-via-ssh-at-hostinger/).

Connect from PowerShell using the username shown in hPanel (commonly `root`):

```powershell
ssh root@YOUR_VPS_IP
```

Replace `root` if hPanel shows a different username. If prompted about the host key on first connection, check the VPS IP in hPanel before accepting it.

## 3. Update and firewall the VPS

Run these commands in the VPS terminal. If your SSH port is not 22, allow your actual port before enabling UFW or you could disconnect yourself.

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git gnupg logrotate python3 util-linux ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw --force enable
sudo ufw status verbose
```

Confirm SSH remains allowed. The daemon health endpoint is bound to `127.0.0.1` only; do not create a public firewall rule for it.

## 4. Install Node.js, pnpm, and service accounts

The repo requires Node.js 22.13 or newer and pins pnpm 11.25.0. These steps install Node.js 24 and create separate non-login service accounts for the daemon and Hermes.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
node --version
npm install --global pnpm@11.25.0
pnpm --version

sudo adduser --system --group --home /nonexistent --no-create-home --shell /usr/sbin/nologin pqe
sudo adduser --disabled-password --gecos '' hermes
sudo passwd --lock hermes
```

Check that Node is v22.13+ and pnpm is exactly 11.25.0 before continuing.

## 5. Clone the public GitHub repository

Clone the branch you pushed in step 1. Replace `main` if you pushed to another branch:

```bash
sudo git clone --branch main https://github.com/coopermsick-67/polymarket-quant-engine.git /opt/polymarket-quant-engine
sudo chown -R root:pqe /opt/polymarket-quant-engine
sudo chmod -R u=rwX,g=rX,o= /opt/polymarket-quant-engine
cd /opt/polymarket-quant-engine
sudo pnpm install --prod --frozen-lockfile
```

## 6. Install and start the paper daemon

The installer creates `/etc/polymarket-quant-engine/engine.env` from a paper-only template, installs systemd and logrotate configuration, and enables restart-on-failure. No wallet, CLOB, or trading API credentials are used.

```bash
cd /opt/polymarket-quant-engine
sudo bash deploy/install-host.sh
sudo systemd-analyze verify /etc/systemd/system/polymarket-quant-engine.service
sudo logrotate --debug /etc/logrotate.d/polymarket-quant-engine
sudo cat /etc/polymarket-quant-engine/engine.env
```

The engine environment file contains the following paper-only settings. Defaults are conservative simulation settings; no trading/API secrets are required or read by this daemon.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `TRADING_MODE` | `paper` | Required; the daemon exits if this is not `paper`. |
| `STATE_DIR` | `/var/lib/polymarket-quant-engine` | Persistent simulated ledger and halt switches. |
| `POLL_INTERVAL_MS` | `15000` | Time between public market discovery, candle, and REST book refreshes. |
| `DECISION_INTERVAL_MS` | `1000` | Time between paper decision scans using current cached and streaming market data. |
| `PQE_DASHBOARD_ORIGINS` | empty | Exact browser origins permitted to read the local, read-only daemon status endpoint. Do not use a wildcard. |
| `DATA_STALE_HALT_MS` | `90000` | Latch a halt when complete fresh data is missing this long. |
| `PAPER_STARTING_CASH` | `100` | Simulated initial cash, used only when creating a new ledger. `pqe-control reset-paper <amount>` archives an offline, position-free paper ledger and sets the next starting balance. |
| `PAPER_MIN_BET_USD` | `1` | Operator minimum paper spend. A market minimum or this floor never overrides a bankroll tier's hard stake, cash reserve, exposure, or liquidity cap. |
| `PAPER_MAX_BET_PCT` | `0.05` | Operator ceiling on one trade, further tightened by the bankroll tier (MICRO 5%, SMALL 4%, GROWTH 3%, STANDARD 2.5%, LARGE 2%). |
| `PAPER_MAX_EXPOSURE_PCT` | `0.15` | Operator ceiling on total cost at risk, further tightened by the tier and correlated crypto exposure caps. |
| `PAPER_MAX_OPEN_POSITIONS` | `5` | Operator ceiling, further tightened by tier limits of 1–5 positions. |
| `PAPER_MAX_DAILY_LOSS_PCT` | `0.05` | Operator daily liquidation-loss ceiling, further tightened to 4% for MICRO and 4.5% for SMALL. A halt blocks new entries; open positions can still lose more. |
| `PAPER_MIN_NET_EDGE` | `0.04` | Operator net-edge floor, further raised by tier to 8% for MICRO, 7% for SMALL, 6% for GROWTH, and 5% for STANDARD. |
| `PAPER_FEE_RATE` | `0.02` | Conservative notional-fee floor; the simulator also applies the CLOB market fee schedule when available and a conservative crypto schedule when it is not. |
| `PAPER_SLIPPAGE_BPS` | `15` | Assumed slippage in basis points for the simulation. |

`PAPER_MIN_BET_PCT` is no longer read. Bankroll sizing comes from typed profiles in `app/lib/bankroll-policy.ts`; environment ceilings can only tighten those profiles. The engine does not force a $1 trade. It PASSes when the CLOB minimum share size is missing, visible ask depth cannot fill that minimum, or the minimum executable cost exceeds any hard cap. A $20 account may have no safe executable opportunities. Edit the environment file only if you understand these simulated limits. Do not add wallet, Polymarket, or messaging secrets to it.

The daemon saves state in `/var/lib/polymarket-quant-engine/paper-state.json`, checks the paper ledger's cash/positions/P&L reconciliation on every cycle, and halts new entries on stale data or risk-limit violations. It admits new paper entries only with a verified Polymarket 60-second TWAP opening Price to Beat and a fresh current price from the matching oracle feed. Coinbase spot or candle-open estimates cannot replace the market's oracle price. A daily-loss halt blocks new entries; it does not force-close open positions, which can continue losing beyond the configured threshold. Kill, pause, and halt files are persistent until an operator changes them. Logs rotate daily and are compressed.

Verify the daemon before installing Hermes:

```bash
sudo systemctl is-enabled polymarket-quant-engine.service
sudo systemctl is-active polymarket-quant-engine.service
curl --fail --silent http://127.0.0.1:8788/livez | python3 -m json.tool
curl --silent http://127.0.0.1:8788/status | python3 -m json.tool
sudo -u pqe /usr/local/bin/pqe-control status
sudo tail -n 50 /var/log/polymarket-quant-engine/trading.log
```

Expected: service is `enabled` and `active`; liveness returns `ok: true`; status says `mode: paper`, `reconciliation: PASS`, and `WAITING_FOR_DATA` or `PAPER_RUNNING`. `/healthz` and `/readyz` return 503 whenever current entry conditions are not ready, including while public endpoints load or a halt is active. If data stays stale, the daemon latches a halt instead of trading.

## 7. Install Hermes as the optional, low-usage operator

systemd alone keeps the daemon running, so Hermes is optional for uptime. Hermes adds a watchdog and, if configured, Telegram or another messaging channel. The recurring five-minute watchdog uses Hermes cron's `--no-agent --script` mode, so the health checks and restarts do not use model tokens. A natural-language summary or chat command calls your chosen model only when you invoke it.

Install Hermes as the separate `hermes` user, follow its setup prompts, and configure the messaging channel you want. Keep any messaging token and model-provider key in Hermes's host-side profile only. The Hermes installer and system gateway instructions are in the [official quickstart](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/quickstart.md) and [gateway documentation](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md).

```bash
sudo -u hermes -H bash -lc 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'
sudo -u hermes -H bash -lc 'hermes setup'
sudo -u hermes -H bash -lc 'hermes gateway setup'
```

Install the repository's restricted operator skill and watchdog script, then install the gateway as a system service:

```bash
sudo install -d -o hermes -g hermes -m 0750 /home/hermes/.hermes/skills/polymarket-ops /home/hermes/.hermes/scripts
sudo install -o hermes -g hermes -m 0640 /opt/polymarket-quant-engine/deploy/hermes/SKILL.md /home/hermes/.hermes/skills/polymarket-ops/SKILL.md
sudo install -o hermes -g hermes -m 0750 /opt/polymarket-quant-engine/deploy/hermes/polymarket-watchdog.sh /home/hermes/.hermes/scripts/polymarket-watchdog.sh

HERMES_BIN="$(sudo -u hermes -H bash -lc 'command -v hermes')"
sudo env HOME=/home/hermes HERMES_HOME=/home/hermes/.hermes "$HERMES_BIN" gateway install --system --run-as-user hermes
sudo systemctl status hermes-gateway --no-pager
```

After connecting your chosen messaging channel, register the script-only watchdog. `telegram` is the Hermes delivery name for Telegram; use the delivery name for the channel you configured:

```bash
sudo -u hermes -H bash -lc 'hermes cron create "every 5m" --no-agent --script /home/hermes/.hermes/scripts/polymarket-watchdog.sh --deliver telegram --name polymarket-paper-watchdog'
sudo -u hermes -H bash -lc 'hermes cron list'
sudo -u hermes -H bash -lc 'hermes cron status'
```

The watchdog checks systemd and the local `/livez`, restarts an unhealthy process with a ten-minute cooldown, and reports state changes/actionable halts. It does not clear a kill or risk halt. Use messaging commands only for status, pause/resume, or kill; clearing a halt requires an explicit operator action. Keep Hermes permissions restricted as installed by `deploy/install-host.sh`.

## 8. Operator commands and final checks

Run on the VPS:

```bash
sudo systemctl is-enabled polymarket-quant-engine.service
sudo systemctl is-active polymarket-quant-engine.service
curl --fail --silent http://127.0.0.1:8788/livez | python3 -m json.tool
curl --silent http://127.0.0.1:8788/status | python3 -m json.tool
sudo -u pqe /usr/local/bin/pqe-control status
sudo logrotate --debug /etc/logrotate.d/polymarket-quant-engine
sudo -u hermes -H bash -lc 'hermes cron list'
sudo -u hermes -H bash -lc 'hermes cron status'
```

Useful controls:

```bash
sudo -u pqe /usr/local/bin/pqe-control pause
sudo -u pqe /usr/local/bin/pqe-control resume
sudo -u pqe /usr/local/bin/pqe-control kill
sudo -u pqe /usr/local/bin/pqe-control clear-halt
sudo -u pqe /usr/local/bin/pqe-control status
sudo systemctl restart polymarket-quant-engine.service
sudo journalctl -u polymarket-quant-engine.service -n 100 --no-pager
```

To intentionally start a fresh paper account while preserving the old ledger, stop the service first. Reset is refused while the daemon is listening or if the saved account has open positions.

```bash
sudo systemctl stop polymarket-quant-engine.service
sudo -u pqe /usr/local/bin/pqe-control reset-paper 100
sudo systemctl start polymarket-quant-engine.service
sudo -u pqe /usr/local/bin/pqe-control status
```

To watch the live paper ledger from an interactive SSH terminal, open a second SSH session and run:

```bash
cd /opt/polymarket-quant-engine
pnpm run dashboard
```

The terminal clock, position countdowns, dashboard view, and paper decision scans target one second. Market discovery, candles, and REST book snapshots refresh in the background every 15 seconds; live WebSocket updates are applied between snapshots. Status reports decision-cycle duration and overrun count. If the dashboard says the endpoint cannot be reached, keep the daemon running in another terminal or check that systemd is active. Press `q` to close only the monitor; systemd continues running the daemon. Press `r` for an immediate refresh. The dashboard reads the local-only status endpoint and does not expose a public web page.

`kill` latches the kill switch and blocks new paper entries. `clear-halt` removes halt flags, so inspect the status and logs first. `pause` blocks new entries without stopping settlement/cashout processing. The service's `/livez`, `/healthz`, `/readyz`, and `/status` bind to localhost only; never expose port 8788 publicly. `/livez` is process liveness; `/healthz` and `/readyz` are trading readiness.

For source updates, review the target commit first, stop the service, back up `/var/lib/polymarket-quant-engine`, install the reviewed code and frozen production dependencies, then start the service and repeat the final checks. Do not deploy an unreviewed `git pull` automatically.

## What this does and does not do

- This host runs the headless **paper** daemon. Its `TRADING_MODE` must remain `paper`; it exits for any other value.
- No live orders are submitted. Do not add wallet private keys or Polymarket trading credentials for this daemon.
- Paper results are simulated and the strategy is heuristic, not a verified profit claim.
- The deterministic engine owns market signals, paper risk limits, stale-data halts, reconciliation, and simulated execution. Hermes only supervises the process and responds to explicit operator requests.
- Hermes watchdog polls every five minutes without model inference. Chat summaries and natural-language commands are on demand and use the model/API you configure.
