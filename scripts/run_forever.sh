#!/usr/bin/env bash
# Supervisor. Modes:
#   bash scripts/run_forever.sh headless   # 24/7 paper/shadow engine + recorder, no browser needed (recommended)
#   bash scripts/run_forever.sh web        # local dashboard server on http://127.0.0.1:8787
# Extra arguments after the mode are passed to the headless runner, e.g.
#   bash scripts/run_forever.sh headless --cash 1000 --latency 900
set -u

mode="${1:-headless}"
shift || true

if [ "$mode" = "headless" ]; then
  exec pnpm run headless:supervised -- "$@"
fi

while true; do
  if [ "$mode" = "web" ]; then
    echo "Starting the dashboard on http://127.0.0.1:8787"
    pnpm run start -- --port 8787
  else
    echo "Unknown mode: $mode (use headless or web)" >&2
    exit 2
  fi
  status=$?
  echo "Process exited with code ${status}. Restarting in 5 seconds..."
  sleep 5
done
