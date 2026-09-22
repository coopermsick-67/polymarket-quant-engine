#!/usr/bin/env bash
set -u

echo "Polymarket Quant Engine supervisor starting on http://127.0.0.1:8787"
echo "Keep a browser tab open at that URL for market scanning and paper settlement."

while true; do
  pnpm run start -- --port 8787
  status=$?
  echo "The local server exited with code ${status}. Restarting in 5 seconds..."
  sleep 5
done
