#!/usr/bin/env bash
# Supervisor. Modes:
#   bash scripts/run_forever.sh headless   # 24/7 paper/shadow engine + recorder, no browser needed (recommended)
#   bash scripts/run_forever.sh web        # local dashboard server on http://127.0.0.1:8787
# Extra arguments after the mode are passed to the headless runner, e.g.
#   bash scripts/run_forever.sh headless --cash 1000 --latency 900
set -u

mode="${1:-headless}"
shift || true

while true; do
  if [ "$mode" = "web" ]; then
    echo "Starting the dashboard on http://127.0.0.1:8787"
    pnpm run start -- --port 8787
  else
    echo "Starting the headless engine (state and recordings in ./data)"
    pnpm run headless -- --auto --record "$@"
  fi
  status=$?
  echo "Process exited with code ${status}. Restarting in 5 seconds..."
  sleep 5
done
