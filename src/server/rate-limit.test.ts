/**
 * Integration tests for rate limiting.
 *
 * Runs in its own worker thread (node --test) so the rate-limit map starts
 * fresh and doesn't share state with auth.test.ts.
 *
 * Uses port 13457 to avoid clashing with auth.test.ts (port 13456).
 *
 * Env vars expected from the test script:
 *   CLAUDE_PROXY_API_KEY=<known key>
 *   RATE_LIMIT_RPM=5    keeps the test fast (only 6 requests needed)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, stopServer, getApiKey } from "./index.js";

const TEST_PORT = 13457;
const LIMIT = parseInt(process.env.RATE_LIMIT_RPM ?? "60", 10);

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function get(path: string, headers?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: TEST_PORT, path, method: "GET", headers },
      (res) => {
        res.resume(); // drain body
        resolve(res.statusCode!);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

before(async () => {
  await startServer({ port: TEST_PORT });
});

after(async () => {
  await stopServer();
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  it("allows requests up to the per-minute limit", async () => {
    const key = getApiKey();
    const headers = { Authorization: `Bearer ${key}` };

    for (let i = 0; i < LIMIT; i++) {
      const status = await get("/v1/models", headers);
      assert.equal(status, 200, `request ${i + 1} of ${LIMIT} should be allowed`);
    }
  });

  it("returns 429 once the per-minute limit is exceeded", async () => {
    // The previous test consumed all LIMIT slots for this IP.
    // One more request should be rejected.
    const key = getApiKey();
    const status = await get("/v1/models", { Authorization: `Bearer ${key}` });
    assert.equal(status, 429);
  });

  it("never rate-limits GET /health regardless of request count", async () => {
    // Make LIMIT+5 extra requests to /health — all should succeed
    for (let i = 0; i < LIMIT + 5; i++) {
      const status = await get("/health");
      assert.equal(status, 200, `/health request ${i + 1} should not be rate-limited`);
    }
  });

  it("returns a well-formed error body on 429", async () => {
    // Already over limit from the first two tests; just need a response body
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: TEST_PORT,
          path: "/v1/models",
          method: "GET",
          headers: { Authorization: `Bearer ${getApiKey()}` },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              assert.equal(res.statusCode, 429);
              const body = JSON.parse(data);
              assert.equal(body.error.code, "rate_limit_exceeded");
              assert.equal(body.error.type, "rate_limit_error");
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  });
});
