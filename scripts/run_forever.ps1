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

if ($Mode -eq "headless") {
  & $pnpm run headless:supervised
  exit $LASTEXITCODE
}

while ($true) {
  if ($Mode -eq "web") {
    Write-Host "Starting the dashboard on http://127.0.0.1:8787"
    & $pnpm run start -- --port 8787
  } else {
    Write-Error "Unknown mode '$Mode'. Use headless or web."
    exit 2
  }
  $exitCode = $LASTEXITCODE
  Write-Warning "Process exited with code $exitCode. Restarting in 5 seconds..."
  Start-Sleep -Seconds 5
}
