#!/usr/bin/env bash
# =============================================================================
# service.sh — Manage the claude-max-api-proxy LaunchAgent
#
# Usage:
#   ./scripts/service.sh start
#   ./scripts/service.sh stop
#   ./scripts/service.sh restart
#   ./scripts/service.sh status
#   ./scripts/service.sh logs
#   ./scripts/service.sh logs:out       (stdout only)
#   ./scripts/service.sh logs:err       (stderr only)
#   ./scripts/service.sh uninstall
# =============================================================================
set -euo pipefail

LABEL="com.claude-max-api-proxy"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
LOG_OUT="/tmp/claude-max-proxy.log"
LOG_ERR="/tmp/claude-max-proxy.err.log"
PORT=3456

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; RESET='\033[0m'

info()  { echo -e "${GREEN}[✓]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[!]${RESET} $*"; }
error() { echo -e "${RED}[✗]${RESET} $*" >&2; exit 1; }

# ── Guards ───────────────────────────────────────────────────────────────────
require_plist() {
  [[ -f "$PLIST" ]] || error "Plist not found: $PLIST\n  Run ./scripts/install.sh first."
}

is_running() {
  launchctl list "$LABEL" &>/dev/null
}

# ── Commands ─────────────────────────────────────────────────────────────────
cmd_start() {
  require_plist
  if is_running; then
    warn "Service is already running."
  else
    launchctl bootstrap "$DOMAIN" "$PLIST"
    sleep 2
    is_running && info "Service started." || error "Service failed to start. Check: tail -f $LOG_ERR"
  fi
}

cmd_stop() {
  if is_running; then
    launchctl bootout "$DOMAIN/$LABEL"
    info "Service stopped."
  else
    warn "Service is not running."
  fi
}

cmd_restart() {
  require_plist
  if is_running; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
    sleep 2
    info "Service restarted."
  else
    warn "Service was not running — starting it."
    cmd_start
  fi
}

cmd_status() {
  echo -e "${BOLD}Service:${RESET}"
  if is_running; then
    PID="$(launchctl list "$LABEL" | awk '/^[0-9]/{print $1}')"
    info "Running (PID: ${PID:-unknown})"
  else
    warn "Not running"
  fi

  echo ""
  echo -e "${BOLD}Health check:${RESET}"
  HEALTH="$(curl -s --max-time 3 "http://localhost:${PORT}/health" 2>/dev/null || true)"
  if echo "$HEALTH" | grep -q '"ok"'; then
    info "http://localhost:${PORT}/health → OK"
  else
    warn "http://localhost:${PORT}/health → not responding"
  fi

  echo ""
  echo -e "${BOLD}Plist:${RESET} $PLIST"
  echo -e "${BOLD}Logs:${RESET}"
  echo "  stdout → $LOG_OUT"
  echo "  stderr → $LOG_ERR"
}

cmd_logs() {
  [[ -f "$LOG_OUT" ]] || touch "$LOG_OUT"
  [[ -f "$LOG_ERR" ]] || touch "$LOG_ERR"
  echo -e "${BOLD}Tailing stdout and stderr (Ctrl+C to stop)${RESET}"
  tail -f "$LOG_OUT" "$LOG_ERR"
}

cmd_logs_out() {
  [[ -f "$LOG_OUT" ]] || touch "$LOG_OUT"
  echo -e "${BOLD}Tailing stdout (Ctrl+C to stop)${RESET}"
  tail -f "$LOG_OUT"
}

cmd_logs_err() {
  [[ -f "$LOG_ERR" ]] || touch "$LOG_ERR"
  echo -e "${BOLD}Tailing stderr (Ctrl+C to stop)${RESET}"
  tail -f "$LOG_ERR"
}

cmd_uninstall() {
  if is_running; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    info "Service stopped."
  fi
  if [[ -f "$PLIST" ]]; then
    rm -f "$PLIST"
    info "Plist removed: $PLIST"
  else
    warn "Plist not found — nothing to remove."
  fi
  info "Uninstall complete. Log files left in place:"
  echo "  $LOG_OUT"
  echo "  $LOG_ERR"
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
case "${1:-}" in
  start)     cmd_start     ;;
  stop)      cmd_stop      ;;
  restart)   cmd_restart   ;;
  status)    cmd_status    ;;
  logs)      cmd_logs      ;;
  logs:out)  cmd_logs_out  ;;
  logs:err)  cmd_logs_err  ;;
  uninstall) cmd_uninstall ;;
  *)
    echo -e "${BOLD}Usage:${RESET} $(basename "$0") <command>"
    echo ""
    echo "Commands:"
    echo "  start       Load and start the LaunchAgent"
    echo "  stop        Stop the LaunchAgent"
    echo "  restart     Restart the running service"
    echo "  status      Show service status and health check"
    echo "  logs        Tail stdout + stderr logs"
    echo "  logs:out    Tail stdout only"
    echo "  logs:err    Tail stderr only"
    echo "  uninstall   Stop service and remove plist"
    exit 1
    ;;
esac
