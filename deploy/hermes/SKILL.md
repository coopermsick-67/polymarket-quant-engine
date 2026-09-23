---
name: polymarket-ops
description: Check, pause, or stop the paper trading daemon and summarize its logs
version: 1.0.0
metadata:
  hermes:
    tags: [polymarket, operations, paper-trading]
    category: operations
---

# Polymarket Paper Daemon Operations

Use this skill only for operator requests about the deployed Polymarket Quant Engine service: status, health, log summaries, pause, resume, kill, clear a halt, or restart after a process failure.

## Hard limits

- The unattended daemon is paper-only. Never enable live execution, edit its environment file, add credentials, submit or cancel exchange orders, or claim a paper result is a live result.
- Use the fixed operator commands below. Do not run arbitrary shell commands, edit source files, change risk limits, or alter systemd units.
- A `KILLED`, `STALE_DATA_HALT`, or `RISK_HALT` state requires the user to request `clear-halt` explicitly. Never clear a halt automatically.
- Restart the daemon only when its process or `/healthz` check is unhealthy. A stale-data or daily-loss halt is a strategy stop; restarting will not fix it.
- A pause blocks new paper entries. Existing paper positions may still cash out or settle.

## Commands

Run these through the host's restricted `sudoers` rules:

- Status: `sudo -n -u pqe /usr/local/bin/pqe-control status`
- Recent logs: `sudo -n /usr/local/bin/pqe-log-tail`
- Pause new entries: `sudo -n -u pqe /usr/local/bin/pqe-control pause`
- Resume entries: `sudo -n -u pqe /usr/local/bin/pqe-control resume`
- Latch the kill switch: `sudo -n -u pqe /usr/local/bin/pqe-control kill`
- Clear explicit halts after the user asks: `sudo -n -u pqe /usr/local/bin/pqe-control clear-halt`
- Restart after an unhealthy process check: `sudo -n /usr/bin/systemctl restart polymarket-quant-engine.service`

For a status or log-summary request, read status and recent logs, then summarize the last successful data cycle, current halt state, paper cash/equity, open positions, reconciliation status, and any errors. Do not infer account or trading outcomes absent from the output.

For a restart request, first check status and `curl --fail --silent http://127.0.0.1:8788/healthz`. Restart only if systemd is inactive or the health endpoint fails. Report whether health recovered.
