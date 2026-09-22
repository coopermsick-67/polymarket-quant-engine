$ErrorActionPreference = "Continue"

$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) {
  $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
}
if (-not $pnpm) {
  Write-Error "pnpm was not found. Install Node.js 22+ and enable Corepack first."
  exit 1
}

Write-Host "Polymarket Quant Engine supervisor starting on http://127.0.0.1:8787"
Write-Host "Keep a browser tab open at that URL for market scanning and paper settlement."

while ($true) {
  & $pnpm run start -- --port 8787
  $exitCode = $LASTEXITCODE
  Write-Warning "The local server exited with code $exitCode. Restarting in 5 seconds..."
  Start-Sleep -Seconds 5
}
