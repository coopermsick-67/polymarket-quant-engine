# Supervisor. Modes:
#   powershell -File .\scripts\run_forever.ps1 headless   # 24/7 paper/shadow engine + recorder (recommended)
#   powershell -File .\scripts\run_forever.ps1 web        # local dashboard on http://127.0.0.1:8787
param([string]$Mode = "headless")
$ErrorActionPreference = "Continue"

$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) { $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source }
if (-not $pnpm) {
  Write-Error "pnpm was not found. Install Node.js 22+ and enable Corepack first."
  exit 1
}

while ($true) {
  if ($Mode -eq "web") {
    Write-Host "Starting the dashboard on http://127.0.0.1:8787"
    & $pnpm run start -- --port 8787
  } else {
    Write-Host "Starting the headless engine (state and recordings in .\data)"
    & $pnpm run headless -- --auto --record
  }
  $exitCode = $LASTEXITCODE
  Write-Warning "Process exited with code $exitCode. Restarting in 5 seconds..."
  Start-Sleep -Seconds 5
}
