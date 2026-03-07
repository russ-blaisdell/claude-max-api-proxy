# macOS Setup

## Install as a LaunchAgent (auto-start on login)

Run the install script from the repo root:

```bash
./scripts/install.sh
```

The script will:

1. Verify `node` and `claude` CLI are in your PATH
2. Build the TypeScript source if needed
3. Generate a cryptographically random 256-bit API key
4. Write `~/Library/LaunchAgents/com.claude-max-api-proxy.plist` with the key baked in
5. Load and start the service immediately
6. Update `~/.openclaw/openclaw.json` with the new API key (if OpenClaw is installed)
7. Print a summary with your API key and a ready-to-run test command

The service will start automatically on every login.

---

## Managing the service

Use `scripts/service.sh` for all day-to-day operations:

```bash
# Show status and health check
./scripts/service.sh status

# Start the service
./scripts/service.sh start

# Stop the service
./scripts/service.sh stop

# Restart the service
./scripts/service.sh restart

# Tail combined stdout + stderr logs
./scripts/service.sh logs

# Tail stdout only
./scripts/service.sh logs:out

# Tail stderr only
./scripts/service.sh logs:err

# Remove the service entirely
./scripts/service.sh uninstall
```

---

## Reinstalling with a new API key

Just run the install script again — it stops the existing service, generates a fresh key, rewrites the plist, reloads the service, and updates your OpenClaw config:

```bash
./scripts/install.sh
```

---

## Log locations

| Stream | Path |
|--------|------|
| stdout | `/tmp/claude-max-proxy.log` |
| stderr | `/tmp/claude-max-proxy.err.log` |

---

## Troubleshooting

### Service won't start

Check the error log:
```bash
./scripts/service.sh logs:err
```

Common causes:
- `claude` CLI not in the PATH baked into the plist — re-run `./scripts/install.sh` after ensuring `which claude` works in your shell
- Node not found — check that `which node` resolves correctly
- Port 3456 already in use — check `lsof -i :3456`

### Health check fails after start

The server may take a second or two after launchctl loads it. Wait and retry:
```bash
curl http://localhost:3456/health
```

### Finding the right paths

```bash
which node    # should be your nvm or system node
which claude  # should be ~/.local/bin/claude or similar
echo $HOME
```
