# Claude Code CLI Provider

**Use your Claude Max subscription ($200/month) with any OpenAI-compatible client — no separate API costs!**

This provider wraps the Claude Code CLI as a subprocess and exposes an OpenAI-compatible HTTP API, allowing tools like Clawdbot, Continue.dev, or any OpenAI-compatible client to use your Claude Max subscription instead of paying per-API-call.

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude Max | $200/month flat | OAuth blocked for third-party API use |
| **This Provider** | $0 extra (uses Max subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. However, the Claude Code CLI *can* use OAuth tokens. This provider bridges that gap by wrapping the CLI and exposing a standard API.

## How It Works

```
Your App (Clawdbot, etc.)
         ↓
    HTTP Request (OpenAI format)
         ↓
   Claude Code CLI Provider (this project)
         ↓
   Claude Code CLI (subprocess)
         ↓
   OAuth Token (from Max subscription)
         ↓
   Anthropic API
         ↓
   Response → OpenAI format → Your App
```

## Features

- **OpenAI-compatible API** — Works with any client that supports OpenAI's API format
- **Streaming support** — Real-time token streaming via Server-Sent Events
- **Multiple models** — Claude Opus, Sonnet, and Haiku
- **Session management** — Maintains conversation context
- **Auto-start service** — Optional LaunchAgent for macOS
- **Zero configuration** — Uses existing Claude CLI authentication
- **API key authentication** — Random 256-bit key generated on startup; fixed key via env var
- **Rate limiting** — Per-IP request throttling to protect your subscription quota
- **Secure by design** — `spawn()` prevents shell injection; CORS disabled by default

## Prerequisites

1. **Claude Max subscription** ($200/month) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

## Installation

```bash
# Clone the repository
git clone https://github.com/anthropics/claude-code-cli-provider.git
cd claude-code-cli-provider

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### Start the server

```bash
node dist/server/standalone.js
```

The server runs at `http://localhost:3456` by default. On startup it prints your API key:

```
========================================
API Key (keep this secret):
  a3f82c1d...
  Tip: set CLAUDE_PROXY_API_KEY=<key> to use a fixed key across restarts.
========================================
```

Copy the key — you need it for every request (except `/health`).

To use a fixed key across restarts, set it before starting:

```bash
CLAUDE_PROXY_API_KEY=your-secret-key node dist/server/standalone.js
```

### Test it

```bash
# Health check (no key required)
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"

# Chat completion (non-streaming)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## API Endpoints

| Endpoint | Method | Auth required | Description |
|----------|--------|---------------|-------------|
| `/health` | GET | No | Health check |
| `/v1/models` | GET | Yes | List available models |
| `/v1/chat/completions` | POST | Yes | Chat completions (streaming & non-streaming) |

All authenticated endpoints require the header:
```
Authorization: Bearer YOUR_API_KEY
```

## Available Models

| Model ID | Maps To |
|----------|---------|
| `claude-opus-4` | Claude Opus 4.5 |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4` | Claude Haiku 4 |

## Configuration with Popular Tools

### Clawdbot

Clawdbot has **built-in support** for Claude CLI OAuth! Check your config:

```bash
clawdbot models status
```

If you see `anthropic:claude-cli=OAuth`, you're already using your Max subscription.

### Continue.dev

Add to your Continue config:

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-opus-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "YOUR_API_KEY"
  }]
}
```

### Generic OpenAI Client (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="YOUR_API_KEY"
)

response = client.chat.completions.create(
    model="claude-opus-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Auto-Start on macOS

Run the install script to set up a LaunchAgent that starts the proxy automatically on login, generates an API key, and configures OpenClaw in one step:

```bash
./scripts/install.sh
```

Manage the running service:

```bash
./scripts/service.sh status
./scripts/service.sh restart
./scripts/service.sh logs
./scripts/service.sh stop
./scripts/service.sh uninstall
```

See `docs/macos-setup.md` for full details and troubleshooting.

## Architecture

```
src/
├── types/
│   ├── claude-cli.ts          # Claude CLI JSON output types
│   └── openai.ts              # OpenAI API types
├── adapter/
│   ├── openai-to-cli.ts       # Convert OpenAI requests → CLI format
│   ├── openai-to-cli.test.ts  # Unit tests: model mapping, prompt formatting, session ID sanitization
│   └── cli-to-openai.ts       # Convert CLI responses → OpenAI format
├── subprocess/
│   └── manager.ts             # Claude CLI subprocess management
├── session/
│   └── manager.ts             # Session ID mapping
├── server/
│   ├── index.ts               # Express server setup, auth middleware, rate limiting
│   ├── routes.ts              # API route handlers
│   ├── standalone.ts          # Entry point
│   ├── auth.test.ts           # Integration tests: authentication and CORS
│   └── rate-limit.test.ts     # Integration tests: rate limiting
└── index.ts                   # Package exports
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_API_KEY` | random 256-bit hex | API key for authenticating requests. Set this to use a fixed key across restarts. |
| `RATE_LIMIT_RPM` | `60` | Maximum requests per IP per minute. |
| `CORS_ORIGIN` | _(unset)_ | If set, enables CORS for that specific origin (e.g. `http://localhost:3000`). Leave unset to block all cross-origin browser requests. |
| `DEBUG` | _(unset)_ | Set to any value to enable request logging. |

## Security

The server is hardened against the most common local proxy attack vectors.

### API Key Authentication

Every request (except `/health`) must include a valid Bearer token:

```
Authorization: Bearer YOUR_API_KEY
```

- A cryptographically random 256-bit key is generated at startup if `CLAUDE_PROXY_API_KEY` is not set
- Key comparison uses `crypto.timingSafeEqual` to prevent timing attacks
- The key is printed to the console on startup so you can configure your clients

### CORS Disabled by Default

The original proxy used `Access-Control-Allow-Origin: *`, which allowed **any website you had open in a browser tab to silently use your Claude Max subscription**. CORS is now disabled by default.

If you need browser-based access from a specific origin, opt in explicitly:

```bash
CORS_ORIGIN=http://localhost:3000 node dist/server/standalone.js
```

### Rate Limiting

Per-IP sliding window rate limiting (default: 60 requests/minute) prevents runaway clients from exhausting your subscription quota. The `/health` endpoint is exempt. Tune with `RATE_LIMIT_RPM`.

### Session ID Sanitization

The `user` field from OpenAI requests is passed to Claude CLI as `--session-id`. It is validated against `[a-zA-Z0-9-]{1,64}` before use — path traversal characters, shell metacharacters, and oversized values are all rejected.

### Subprocess Hardening

- Uses `spawn()` (not `exec()`) — no shell interpretation of prompt content
- Strips the `CLAUDECODE` environment variable to prevent recursive self-invocation
- Defaults the subprocess working directory to `$HOME` rather than inheriting `process.cwd()`, so the CLI never implicitly gains access to a sensitive directory

## Cost Savings Example

| Usage | API Cost | With This Provider |
|-------|----------|-------------------|
| 1M input tokens/month | ~$15 | $0 (included in Max) |
| 500K output tokens/month | ~$37.50 | $0 (included in Max) |
| **Monthly Total** | **~$52.50** | **$0 extra** |

If you're already paying for Claude Max, this provider lets you use that subscription for API-style access at no additional cost.

## Troubleshooting

### "Claude CLI not found"

Install and authenticate the CLI:
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### Streaming returns immediately with no content

Ensure you're using `-N` flag with curl (disables buffering):
```bash
curl -N -X POST http://localhost:3456/v1/chat/completions ...
```

### Server won't start

Check that the Claude CLI is in your PATH:
```bash
which claude
```

## Testing

The test suite uses Node's built-in test runner — no extra dependencies required.

```bash
npm test
```

### Test Coverage

**`src/adapter/openai-to-cli.test.ts`** — 17 unit tests

| Suite | What's tested |
|-------|--------------|
| `extractModel` | Direct model names, short aliases, provider prefix stripping, unknown model default |
| `messagesToPrompt` | Plain user messages, `<system>` tag wrapping, `<previous_response>` wrapping, whitespace trimming, multi-message ordering |
| `sanitizeSessionId` | Valid UUIDs, alphanumeric IDs, hyphenated IDs, path traversal rejection, shell metacharacter rejection, length boundary (64 chars) |

**`src/server/auth.test.ts`** — 10 integration tests

| Suite | What's tested |
|-------|--------------|
| `API key authentication` | `/health` bypass, missing header → 401, no Bearer prefix → 401, wrong key → 401, correct key → 200, unauthenticated chat completions → 401, 400 vs 401 distinction for invalid body |
| `CORS hardening` | `Access-Control-Allow-Origin` absent when `CORS_ORIGIN` unset, `Access-Control-Allow-Methods` absent when CORS disabled |

**`src/server/rate-limit.test.ts`** — 4 integration tests

| Suite | What's tested |
|-------|--------------|
| `rate limiting` | All requests up to limit succeed, request at limit+1 returns 429, `/health` never rate-limited regardless of count, 429 response has correct `error.code` and `error.type` |

Each test file runs in an isolated worker thread so rate-limit counters don't bleed between files. The test script sets `RATE_LIMIT_RPM=5` to keep the suite fast.

## Contributing

Contributions welcome! Please submit PRs with tests.

## License

MIT

## Acknowledgments

- Built for use with [Clawdbot](https://clawd.bot)
- Powered by [Claude Code CLI](https://github.com/anthropics/claude-code)
