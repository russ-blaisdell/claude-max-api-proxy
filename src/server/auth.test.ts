/**
 * Integration tests for API key authentication and CORS hardening.
 *
 * Starts a real Express server on a test port. Each request uses Node's
 * built-in http module — no extra dependencies required.
 *
 * This file runs in its own worker thread (node --test isolates test files),
 * so the module-level API_KEY and rate-limit map start fresh.
 *
 * Env vars expected from the test script:
 *   CLAUDE_PROXY_API_KEY=<known key>   so we can assert exact 401 vs 200
 *   RATE_LIMIT_RPM=5                   high enough that auth tests don't trip it
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, stopServer, getApiKey } from "./index.js";

const TEST_PORT = 13456;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

function request(opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path: opts.path,
        method: opts.method,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: data ? JSON.parse(data) : null,
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
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
// Authentication
// ---------------------------------------------------------------------------

describe("API key authentication", () => {
  it("allows GET /health without any API key", async () => {
    const res = await request({ method: "GET", path: "/health" });
    assert.equal(res.status, 200);
  });

  it("rejects GET /v1/models with no Authorization header", async () => {
    const res = await request({ method: "GET", path: "/v1/models" });
    assert.equal(res.status, 401);
    assert.equal((res.body as any).error.code, "missing_api_key");
  });

  it("rejects GET /v1/models when Authorization header lacks Bearer prefix", async () => {
    const res = await request({
      method: "GET",
      path: "/v1/models",
      headers: { Authorization: getApiKey() }, // raw key, no "Bearer "
    });
    assert.equal(res.status, 401);
    assert.equal((res.body as any).error.code, "missing_api_key");
  });

  it("rejects GET /v1/models with a wrong API key", async () => {
    const res = await request({
      method: "GET",
      path: "/v1/models",
      headers: { Authorization: "Bearer wrong-key-value" },
    });
    assert.equal(res.status, 401);
    assert.equal((res.body as any).error.code, "invalid_api_key");
  });

  it("allows GET /v1/models with the correct API key", async () => {
    const res = await request({
      method: "GET",
      path: "/v1/models",
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as any).object, "list");
  });

  it("rejects POST /v1/chat/completions without API key", async () => {
    const res = await request({
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.equal(res.status, 401);
  });

  it("rejects POST /v1/chat/completions with wrong API key", async () => {
    const res = await request({
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer bad-key" },
      body: {
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.equal(res.status, 401);
  });

  it("returns 400 (not 401) for authenticated requests with invalid body", async () => {
    // Passes auth — fails at request validation, proving auth layer was satisfied
    const res = await request({
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: `Bearer ${getApiKey()}` },
      body: { model: "claude-sonnet-4", messages: [] }, // empty messages array
    });
    // Auth passed; route validation rejects the empty messages array
    assert.equal(res.status, 400);
    assert.equal((res.body as any).error.code, "invalid_messages");
  });
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe("CORS hardening", () => {
  it("does not send Access-Control-Allow-Origin when CORS_ORIGIN env is unset", async () => {
    // CORS_ORIGIN is not set in the test script, so header must be absent
    const res = await request({ method: "GET", path: "/health" });
    assert.equal(
      res.headers["access-control-allow-origin"],
      undefined,
      "wildcard CORS header must not be present"
    );
  });

  it("does not send Access-Control-Allow-Methods when CORS is disabled", async () => {
    const res = await request({ method: "GET", path: "/health" });
    assert.equal(res.headers["access-control-allow-methods"], undefined);
  });
});
