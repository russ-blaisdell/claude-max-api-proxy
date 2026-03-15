#!/usr/bin/env bash
# =============================================================================
# service.sh — Manage the claude-max-api-proxy service
#
# Supports:
#   - Linux:  systemd user service
#   - macOS:  LaunchAgent
#
# Usage:
#   ./scripts/service.sh start
#   ./scripts/service.sh stop
#   ./scripts/service.sh restart
#   ./scripts/service.sh status
#   ./scripts/service.sh logs
#   ./scripts/service.sh logs:out       (stdout only — macOS only)
#   ./scripts/service.sh logs:err       (stderr only — macOS only)
#   ./scripts/service.sh uninstall
# =============================================================================
set -euo pipefail

# ── Detect platform ──────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Linux)  PLATFORM="linux"  ;;
  Darwin) PLATFORM="macos"  ;;
  *)      echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

# ── Shared config ────────────────────────────────────────────────────────
PORT=3456

# ── Platform-specific config ─────────────────────────────────────────────
if [[ "$PLATFORM" == "linux" ]]; then
  SERVICE_NAME="claude-max-api-proxy"
  UNIT_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
else
  LABEL="com.claude-max-api-proxy"
  PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  DOMAIN="gui/$(id -u)"
  LOG_OUT="/tmp/claude-max-proxy.log"
  LOG_ERR="/tmp/claude-max-proxy.err.log"
fi

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; RESET='\033[0m'

info()  { echo -e "${GREEN}[✓]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[!]${RESET} $*"; }
error() { echo -e "${RED}[✗]${RESET} $*" >&2; exit 1; }

# ── Guards ───────────────────────────────────────────────────────────────────
require_installed() {
  if [[ "$PLATFORM" == "linux" ]]; then
    [[ -f "$UNIT_FILE" ]] || error "Unit file not found: $UNIT_FILE\n  Run ./scripts/install.sh first."
  else
    [[ -f "$PLIST" ]] || error "Plist not found: $PLIST\n  Run ./scripts/install.sh first."
  fi
}

is_running() {
  if [[ "$PLATFORM" == "linux" ]]; then
    systemctl --user is-active "$SERVICE_NAME" &>/dev/null
  else
    launchctl list "$LABEL" &>/dev/null
  fi
}

# ── Commands ─────────────────────────────────────────────────────────────────
cmd_start() {
  require_installed
  if is_running; then
    warn "Service is already running."
  else
    if [[ "$PLATFORM" == "linux" ]]; then
      systemctl --user start "$SERVICE_NAME"
      sleep 2
      is_running && info "Service started." || error "Service failed to start. Check: journalctl --user -u $SERVICE_NAME -e"
    else
      launchctl bootstrap "$DOMAIN" "$PLIST"
      sleep 2
      is_running && info "Service started." || error "Service failed to start. Check: tail -f $LOG_ERR"
    fi
  fi
}

cmd_stop() {
  if is_running; then
    if [[ "$PLATFORM" == "linux" ]]; then
      systemctl --user stop "$SERVICE_NAME"
    else
      launchctl bootout "$DOMAIN/$LABEL"
    fi
    info "Service stopped."
  else
    warn "Service is not running."
  fi
}

cmd_restart() {
  require_installed
  if is_running; then
    if [[ "$PLATFORM" == "linux" ]]; then
      systemctl --user restart "$SERVICE_NAME"
      sleep 2
      info "Service restarted."
    else
      launchctl kickstart -k "$DOMAIN/$LABEL"
      sleep 2
      info "Service restarted."
    fi
  else
    warn "Service was not running — starting it."
    cmd_start
  fi
}

cmd_status() {
  echo -e "${BOLD}Service:${RESET}"
  if is_running; then
    if [[ "$PLATFORM" == "linux" ]]; then
      PID="$(systemctl --user show "$SERVICE_NAME" --property=MainPID --value 2>/dev/null)"
      info "Running (PID: ${PID:-unknown})"
    else
      PID="$(launchctl list "$LABEL" 2>/dev/null | grep '"PID"' | grep -o '[0-9]*')"
      info "Running (PID: ${PID:-unknown})"
    fi
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
  if [[ "$PLATFORM" == "linux" ]]; then
    echo -e "${BOLD}Unit:${RESET} $UNIT_FILE"
    echo -e "${BOLD}Logs:${RESET}  journalctl --user -u $SERVICE_NAME -f"
  else
    echo -e "${BOLD}Plist:${RESET} $PLIST"
    echo -e "${BOLD}Logs:${RESET}"
    echo "  stdout → $LOG_OUT"
    echo "  stderr → $LOG_ERR"
  fi
}

cmd_logs() {
  if [[ "$PLATFORM" == "linux" ]]; then
    echo -e "${BOLD}Following journal logs (Ctrl+C to stop)${RESET}"
    journalctl --user -u "$SERVICE_NAME" -f
  else
    [[ -f "$LOG_OUT" ]] || touch "$LOG_OUT"
    [[ -f "$LOG_ERR" ]] || touch "$LOG_ERR"
    echo -e "${BOLD}Tailing stdout and stderr (Ctrl+C to stop)${RESET}"
    tail -f "$LOG_OUT" "$LOG_ERR"
  fi
}

cmd_logs_out() {
  if [[ "$PLATFORM" == "linux" ]]; then
    echo -e "${BOLD}Following journal logs — priority info (Ctrl+C to stop)${RESET}"
    journalctl --user -u "$SERVICE_NAME" -f -p info
  else
    [[ -f "$LOG_OUT" ]] || touch "$LOG_OUT"
    echo -e "${BOLD}Tailing stdout (Ctrl+C to stop)${RESET}"
    tail -f "$LOG_OUT"
  fi
}

cmd_logs_err() {
  if [[ "$PLATFORM" == "linux" ]]; then
    echo -e "${BOLD}Following journal logs — priority err (Ctrl+C to stop)${RESET}"
    journalctl --user -u "$SERVICE_NAME" -f -p err
  else
    [[ -f "$LOG_ERR" ]] || touch "$LOG_ERR"
    echo -e "${BOLD}Tailing stderr (Ctrl+C to stop)${RESET}"
    tail -f "$LOG_ERR"
  fi
}

cmd_uninstall() {
  if is_running; then
    if [[ "$PLATFORM" == "linux" ]]; then
      systemctl --user stop "$SERVICE_NAME"
    else
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    fi
    info "Service stopped."
  fi

  if [[ "$PLATFORM" == "linux" ]]; then
    if [[ -f "$UNIT_FILE" ]]; then
      systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
      rm -f "$UNIT_FILE"
      systemctl --user daemon-reload
      info "Unit file removed: $UNIT_FILE"
    else
      warn "Unit file not found — nothing to remove."
    fi
  else
    if [[ -f "$PLIST" ]]; then
      rm -f "$PLIST"
      info "Plist removed: $PLIST"
    else
      warn "Plist not found — nothing to remove."
    fi
    info "Uninstall complete. Log files left in place:"
    echo "  $LOG_OUT"
    echo "  $LOG_ERR"
  fi

  info "Uninstall complete."
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
    echo "  start       Start the service"
    echo "  stop        Stop the service"
    echo "  restart     Restart the running service"
    echo "  status      Show service status and health check"
    echo "  logs        Follow all logs"
    if [[ "$PLATFORM" == "macos" ]]; then
      echo "  logs:out    Tail stdout only"
      echo "  logs:err    Tail stderr only"
    else
      echo "  logs:out    Follow logs (info priority)"
      echo "  logs:err    Follow logs (error priority)"
    fi
    echo "  uninstall   Stop service and remove unit/plist"
    exit 1
    ;;
esac
