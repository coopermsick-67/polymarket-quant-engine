#!/usr/bin/env bash
set -u

UNIT=polymarket-quant-engine.service
HEALTH_URL=http://127.0.0.1:8788/livez
STATUS_URL=http://127.0.0.1:8788/status
HOME_DIR="${HOME:-/home/hermes}"
STATE_DIR="${HOME_DIR}/.hermes/scripts"
LAST_ALERT="${STATE_DIR}/.polymarket-watchdog-state"
LAST_RESTART="${STATE_DIR}/.polymarket-watchdog-restart"
RESTART_COOLDOWN_SECONDS=600

mkdir -p "${STATE_DIR}"
exec 9>"${STATE_DIR}/.polymarket-watchdog.lock"
flock -n 9 || exit 0

emit_on_change() {
  local key="$1"
  local message="$2"
  local previous=""
  [[ -f "${LAST_ALERT}" ]] && previous="$(cat "${LAST_ALERT}")"
  if [[ "${previous}" != "${key}" ]]; then
    printf '%s\n' "${key}" > "${LAST_ALERT}"
    printf '%s\n' "${message}"
  fi
}

append_log_tail() {
  sudo -n /usr/local/bin/pqe-log-tail 2>/dev/null | tail -n 25 || true
}

failure=""
if ! systemctl is-active --quiet "${UNIT}"; then
  failure="systemd reports ${UNIT} inactive"
elif ! curl --fail --silent --show-error --max-time 5 "${HEALTH_URL}" >/dev/null 2>&1; then
  failure="the daemon health endpoint is unavailable"
fi

if [[ -n "${failure}" ]]; then
  now="$(date +%s)"
  last="$(cat "${LAST_RESTART}" 2>/dev/null || printf '0')"
  action="restart skipped by the 10-minute cooldown"
  if (( now - last >= RESTART_COOLDOWN_SECONDS )); then
    printf '%s\n' "${now}" > "${LAST_RESTART}"
    sudo -n /usr/bin/systemctl reset-failed "${UNIT}" >/dev/null 2>&1 || true
    if sudo -n /usr/bin/systemctl restart "${UNIT}"; then
      sleep 3
      if systemctl is-active --quiet "${UNIT}" && curl --fail --silent --max-time 5 "${HEALTH_URL}" >/dev/null 2>&1; then
        action="restart succeeded and the health endpoint recovered"
      else
        action="restart returned, but the health endpoint has not recovered"
      fi
    else
      action="restart failed; see the recent daemon log excerpt below"
    fi
  fi
  message=$'⚠ Trading process needs attention.\n'"${failure}. ${action}.\nRecent daemon output:\n$(append_log_tail)"
  emit_on_change "process:${failure}:${action}" "${message}"
  exit 0
fi

status="$(curl --fail --silent --max-time 5 "${STATUS_URL}" 2>/dev/null || true)"
trading_state="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tradingState", "STATUS_UNAVAILABLE"))' <<<"${status}" 2>/dev/null || printf 'STATUS_UNAVAILABLE')"
last_error="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("lastError") or "")' <<<"${status}" 2>/dev/null || true)"
readiness="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("readiness", "READINESS_UNKNOWN"))' <<<"${status}" 2>/dev/null || printf 'READINESS_UNKNOWN')"
if [[ "${readiness}" == "DEGRADED" && ( "${trading_state}" == "PAPER_RUNNING" || "${trading_state}" == "WAITING_FOR_DATA" ) ]]; then
  trading_state="DEGRADED"
fi

case "${trading_state}" in
  STALE_DATA_HALT)
    emit_on_change "state:${trading_state}" "⚠ Paper trading is halted by the stale-data latch. The service is running and will not open positions. Check upstream feeds and status before clearing the halt."
    ;;
  RISK_HALT)
    emit_on_change "state:${trading_state}" "⚠ The paper daily-loss limit latched. New entries are blocked. Review the paper ledger before using clear-halt."
    ;;
  DEGRADED|STATUS_UNAVAILABLE|PROCESS_UNAVAILABLE)
    emit_on_change "state:${trading_state}:${last_error}" "⚠ Paper daemon status is ${trading_state}. ${last_error}"
    ;;
  PAPER_RUNNING|WAITING_FOR_DATA|PAUSED|KILLED)
    previous=""
    [[ -f "${LAST_ALERT}" ]] && previous="$(cat "${LAST_ALERT}")"
    if [[ "${previous}" == state:* || "${previous}" == process:* ]]; then
      emit_on_change "state:recovered" "✓ Paper daemon recovered. Current state: ${trading_state}."
    fi
    ;;
esac
