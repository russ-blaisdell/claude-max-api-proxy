#!/usr/bin/env bash
# =============================================================================
# install.sh — Install claude-max-api-proxy as a system service
#
# Supports:
#   - Linux:  systemd user service (with lingering for boot start)
#   - macOS:  LaunchAgent
#
# What this script does:
#   1. Verifies node and claude CLI are available
#   2. Builds the TypeScript source if dist/ is missing
#   3. Generates a cryptographically random API key
#   4. Writes the appropriate service unit / plist
#   5. Enables, loads, and starts the service
#   6. Updates ~/.openclaw/openclaw.json with the new API key (if present)
#   7. Prints a summary with the API key and next steps
#
# Usage:
#   ./scripts/install.sh
#
# To reinstall with a fresh key, just run again — it handles the reload.
# =============================================================================
set -euo pipefail

# ── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${GREEN}[✓]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[!]${RESET} $*"; }
error()   { echo -e "${RED}[✗]${RESET} $*" >&2; exit 1; }
section() { echo -e "\n${BOLD}── $* ──${RESET}"; }

# ── Detect platform ──────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Linux)  PLATFORM="linux"  ;;
  Darwin) PLATFORM="macos"  ;;
  *)      error "Unsupported OS: $OS" ;;
esac

# ── Paths ───────────────────────────────────────────────────────────────────
LABEL="com.claude-max-api-proxy"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
PORT=3456

# Resolve the repo root (one directory above this script)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STANDALONE="$REPO_DIR/dist/server/standalone.js"

# Platform-specific paths
if [[ "$PLATFORM" == "linux" ]]; then
  SERVICE_NAME="claude-max-api-proxy"
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_FILE="$UNIT_DIR/${SERVICE_NAME}.service"
else
  PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  LOG_OUT="/tmp/claude-max-proxy.log"
  LOG_ERR="/tmp/claude-max-proxy.err.log"
fi

# ── Step 1: Prerequisites ────────────────────────────────────────────────────
section "Checking prerequisites"

NODE_PATH="$(which node 2>/dev/null)" || error "node not found in PATH. Install Node.js >= 20."
info "node: $NODE_PATH ($(node --version))"

CLAUDE_PATH="$(which claude 2>/dev/null)" || error "claude CLI not found. Run: npm install -g @anthropic-ai/claude-code"
info "claude: $CLAUDE_PATH"

info "Platform: $PLATFORM"

# ── Step 2: Build ────────────────────────────────────────────────────────────
section "Building"

if [[ ! -f "$STANDALONE" ]]; then
  warn "dist/ not found — building TypeScript..."
  cd "$REPO_DIR" && npm run build
  info "Build complete"
else
  info "dist/ already built (run 'npm run build' to rebuild)"
fi

# ── Step 3: Generate API key ─────────────────────────────────────────────────
section "Generating API key"

API_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
info "API key generated (256-bit)"

# ── Step 4: Install service ──────────────────────────────────────────────────
if [[ "$PLATFORM" == "linux" ]]; then
  section "Installing systemd user service"

  mkdir -p "$UNIT_DIR"

  # Stop existing service gracefully before overwriting the unit
  if systemctl --user is-active "$SERVICE_NAME" &>/dev/null; then
    warn "Existing service found — stopping it first..."
    systemctl --user stop "$SERVICE_NAME"
  fi

  cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Claude Max API Proxy — OpenAI-compatible local API using your Claude Max subscription
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_PATH} ${STANDALONE}
Restart=on-failure
RestartSec=5
Environment=HOME=${HOME}
Environment=PATH=$(dirname "$CLAUDE_PATH"):$(dirname "$NODE_PATH"):/usr/local/bin:/usr/bin:/bin
Environment=CLAUDE_PROXY_API_KEY=${API_KEY}
WorkingDirectory=${HOME}

[Install]
WantedBy=default.target
UNIT

  info "Unit file written to: $UNIT_FILE"

  # Reload, enable, and start
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user start "$SERVICE_NAME"

  # Enable lingering so the service starts at boot (before login)
  if ! loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q "yes"; then
    warn "Enabling lingering so service starts at boot..."
    loginctl enable-linger "$USER" 2>/dev/null || warn "Could not enable linger — you may need: sudo loginctl enable-linger $USER"
  fi

  sleep 2
  if systemctl --user is-active "$SERVICE_NAME" &>/dev/null; then
    info "Service enabled and running"
  else
    error "Service failed to start. Check logs: journalctl --user -u $SERVICE_NAME -e"
  fi

else
  # ── macOS: LaunchAgent ──────────────────────────────────────────────────
  section "Installing LaunchAgent"

  mkdir -p "$HOME/Library/LaunchAgents"

  # Stop existing service gracefully before overwriting the plist
  DOMAIN="gui/$(id -u)"
  if launchctl list "$LABEL" &>/dev/null; then
    warn "Existing service found — stopping it first..."
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    sleep 1
  fi

  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>

    <key>Label</key>
    <string>${LABEL}</string>

    <key>Comment</key>
    <string>Claude Max API Proxy — OpenAI-compatible local API using your Claude Max subscription</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_PATH}</string>
      <string>${STANDALONE}</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${HOME}</string>
      <key>PATH</key>
      <string>$(dirname "$CLAUDE_PATH"):$(dirname "$NODE_PATH"):/usr/local/bin:/usr/bin:/bin</string>
      <key>CLAUDE_PROXY_API_KEY</key>
      <string>${API_KEY}</string>
    </dict>

    <key>StandardOutPath</key>
    <string>${LOG_OUT}</string>

    <key>StandardErrorPath</key>
    <string>${LOG_ERR}</string>

  </dict>
</plist>
PLIST

  info "Plist written to: $PLIST"

  launchctl bootstrap "$DOMAIN" "$PLIST"
  sleep 2

  if launchctl list "$LABEL" &>/dev/null; then
    info "Service loaded and running"
  else
    error "Service failed to load. Check logs: tail -f $LOG_ERR"
  fi
fi

# ── Step 5: Health check ─────────────────────────────────────────────────────
section "Health check"

HEALTH="$(curl -s --max-time 5 "http://localhost:${PORT}/health" || true)"
if echo "$HEALTH" | grep -q '"ok"'; then
  info "Server is healthy at http://localhost:${PORT}"
else
  warn "Health check did not return ok yet — server may still be starting."
  if [[ "$PLATFORM" == "linux" ]]; then
    warn "Run: journalctl --user -u $SERVICE_NAME -f"
  else
    warn "Run: curl http://localhost:${PORT}/health"
  fi
fi

# ── Step 6: Update OpenClaw config ──────────────────────────────────────────
section "Configuring OpenClaw"

if [[ -f "$OPENCLAW_CONFIG" ]]; then
  # Use node to safely merge — never overwrites unrelated keys
  node --input-type=module <<JS
import { readFileSync, writeFileSync } from 'fs';

const path = '${OPENCLAW_CONFIG}';
const config = JSON.parse(readFileSync(path, 'utf8'));

// Update env block
config.env = config.env ?? {};
config.env.OPENAI_API_KEY    = '${API_KEY}';
config.env.OPENAI_BASE_URL   = 'http://localhost:${PORT}/v1';

// Update models provider block
config.models                          = config.models          ?? {};
config.models.providers                = config.models.providers ?? {};
config.models.providers.openai         = config.models.providers.openai ?? {};
config.models.providers.openai.baseUrl = 'http://localhost:${PORT}/v1';
config.models.providers.openai.apiKey  = '${API_KEY}';

writeFileSync(path, JSON.stringify(config, null, 2) + '\\n');
console.log('openclaw.json updated');
JS
  info "OpenClaw config updated: $OPENCLAW_CONFIG"
else
  warn "OpenClaw config not found at $OPENCLAW_CONFIG — skipping."
  warn "If you install OpenClaw later, set these values manually:"
  warn "  models.providers.openai.apiKey = \"${API_KEY}\""
  warn "  env.OPENAI_API_KEY             = \"${API_KEY}\""
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD} Claude Max API Proxy — Installation Complete        ${RESET}"
echo -e "${BOLD}════════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${BOLD}API Key:${RESET}  ${API_KEY}"
echo -e "  ${BOLD}Endpoint:${RESET} http://localhost:${PORT}/v1"

if [[ "$PLATFORM" == "linux" ]]; then
  echo -e "  ${BOLD}Logs:${RESET}     journalctl --user -u ${SERVICE_NAME} -f"
else
  echo -e "  ${BOLD}Logs:${RESET}     tail -f ${LOG_OUT}"
  echo -e "            tail -f ${LOG_ERR}"
fi

echo ""
echo -e "  Manage the service with:"
echo -e "  ${BOLD}./scripts/service.sh${RESET} {start|stop|restart|status|logs|uninstall}"
echo ""
echo -e "  Test:"
echo -e "  curl http://localhost:${PORT}/v1/models \\"
echo -e "    -H \"Authorization: Bearer ${API_KEY}\""
echo ""
