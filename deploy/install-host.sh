#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/polymarket-quant-engine
STATE_DIR=/var/lib/polymarket-quant-engine
LOG_DIR=/var/log/polymarket-quant-engine
ENV_DIR=/etc/polymarket-quant-engine

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 77
fi
if [[ ! -f "${APP_DIR}/package.json" ]]; then
  echo "Expected the repository at ${APP_DIR}." >&2
  exit 66
fi
if ! id pqe >/dev/null 2>&1; then
  echo "Create the pqe service account before running this installer." >&2
  exit 67
fi
if ! command -v node >/dev/null || ! command -v pnpm >/dev/null; then
  echo "Install Node.js 22.13+ and pnpm 11.25.0 before running this installer." >&2
  exit 69
fi
if [[ "$(pnpm --version)" != "11.25.0" ]]; then
  echo "This repository requires pnpm 11.25.0." >&2
  exit 69
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)' || {
  echo "The repository requires Node.js 22.13 or newer." >&2
  exit 69
}
if [[ ! -f "${APP_DIR}/node_modules/tsx/dist/cli.mjs" ]]; then
  echo "Install production dependencies with pnpm install --prod --frozen-lockfile before starting the service." >&2
  exit 68
fi

install -d -o pqe -g pqe -m 0750 "${STATE_DIR}" "${LOG_DIR}"
install -d -o root -g pqe -m 0750 "${ENV_DIR}"
touch "${LOG_DIR}/trading.log"
chown pqe:pqe "${LOG_DIR}/trading.log"
chmod 0640 "${LOG_DIR}/trading.log"

if [[ ! -e "${ENV_DIR}/engine.env" ]]; then
  install -o root -g pqe -m 0640 "${APP_DIR}/deploy/systemd/engine.env.example" "${ENV_DIR}/engine.env"
fi
install -o root -g root -m 0644 "${APP_DIR}/deploy/systemd/polymarket-quant-engine.service" /etc/systemd/system/polymarket-quant-engine.service
install -o root -g root -m 0644 "${APP_DIR}/deploy/logrotate/polymarket-quant-engine" /etc/logrotate.d/polymarket-quant-engine
install -o root -g root -m 0755 "${APP_DIR}/deploy/systemd/pqe-control" /usr/local/bin/pqe-control
install -o root -g root -m 0755 "${APP_DIR}/deploy/systemd/pqe-log-tail" /usr/local/bin/pqe-log-tail

if id hermes >/dev/null 2>&1; then
  sudoers_tmp="$(mktemp)"
  cat > "${sudoers_tmp}" <<'SUDOERS'
hermes ALL=(root) NOPASSWD: /usr/bin/systemctl reset-failed polymarket-quant-engine.service, /usr/bin/systemctl restart polymarket-quant-engine.service, /usr/local/bin/pqe-log-tail
hermes ALL=(pqe) NOPASSWD: /usr/local/bin/pqe-control status, /usr/local/bin/pqe-control pause, /usr/local/bin/pqe-control resume, /usr/local/bin/pqe-control kill, /usr/local/bin/pqe-control clear-halt
SUDOERS
  chmod 0440 "${sudoers_tmp}"
  visudo -cf "${sudoers_tmp}"
  install -o root -g root -m 0440 "${sudoers_tmp}" /etc/sudoers.d/pqe-hermes
  rm -f "${sudoers_tmp}"
  visudo -cf /etc/sudoers.d/pqe-hermes
else
  echo "Hermes account not found; run this installer again after creating it to install restricted operator permissions."
fi

systemctl daemon-reload
systemctl enable --now polymarket-quant-engine.service
systemctl --no-pager --full status polymarket-quant-engine.service
