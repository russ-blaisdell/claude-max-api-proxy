/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration.
 * Uses a concurrency pool to limit simultaneous CLI subprocesses
 * and a dedup cache to avoid redundant work for identical requests.
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { spawnWithRetry } from "../subprocess/manager.js";
import type { ClaudeSubprocess } from "../subprocess/manager.js";
import { pool, PoolFullError } from "../subprocess/pool.js";
import { dedupCache, DedupCache, InflightRequest } from "../server/dedup.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type {
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming.
 * Acquires a pool slot before spawning a subprocess and releases it on completion.
 * Identical concurrent requests are deduped to share a single subprocess.
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (
      !body.messages ||
      !Array.isArray(body.messages) ||
      body.messages.length === 0
    ) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);
    const dedupKey = DedupCache.makeKey(cliInput.prompt, cliInput.model);

    // Check dedup cache — if an identical request is already in-flight, piggyback
    const existing = dedupCache.get(dedupKey);
    if (existing) {
      console.error(
        `[Routes] Dedup hit for key ${dedupKey}, piggybacking on existing subprocess`
      );
      if (stream) {
        await handleDedupStreamingResponse(res, existing, requestId);
      } else {
        await handleDedupNonStreamingResponse(res, existing, requestId);
      }
      return;
    }

    // Acquire a pool slot (may queue, may throw PoolFullError)
    await pool.acquire();

    let succeeded = false;
    const inflight = dedupCache.register(dedupKey);

    try {
      // Spawn subprocess with retry
      const subprocess = await spawnWithRetry(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
      });

      // Wire subprocess events to the dedup inflight emitter
      wireSubprocessToInflight(subprocess, inflight);

      if (stream) {
        await handleStreamingResponse(req, res, subprocess, inflight, requestId);
      } else {
        await handleNonStreamingResponse(res, subprocess, inflight, requestId);
      }
      succeeded = true;
    } finally {
      pool.release(succeeded);
    }
  } catch (error) {
    if (error instanceof PoolFullError) {
      console.error("[Routes] Pool full, returning 503");
      if (!res.headersSent) {
        res.setHeader("Retry-After", "5");
        res.status(503).json({
          error: {
            message: error.message,
            type: "server_busy",
            code: "capacity_exceeded",
          },
        });
      }
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Bridge subprocess events to the dedup InflightRequest emitter
 * so that piggybacking consumers see the same events.
 */
function wireSubprocessToInflight(
  subprocess: ClaudeSubprocess,
  inflight: InflightRequest
): void {
  subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
    inflight.emitBuffered("content_delta", event);
  });
  subprocess.on("assistant", (message: ClaudeCliAssistant) => {
    inflight.emitBuffered("assistant", message);
  });
  subprocess.on("result", (result: ClaudeCliResult) => {
    inflight.emitBuffered("result", result);
    inflight.emit("done");
  });
  subprocess.on("error", (error: Error) => {
    inflight.emitBuffered("subprocess_error", error);
    inflight.emit("error", error);
  });
  subprocess.on("close", (code: number | null) => {
    inflight.emitBuffered("close", code);
  });
}

// ---------------------------------------------------------------------------
// Primary handlers — own the subprocess lifecycle
// ---------------------------------------------------------------------------

/**
 * Handle streaming response (SSE)
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  inflight: InflightRequest,
  requestId: string
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.flushHeaders();
  res.write(":ok\n\n");

  return new Promise<void>((resolve) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;

    res.on("close", () => {
      if (!isComplete) {
        // Only kill subprocess if no other consumers are piggybacking
        if (inflight.refCount <= 1) {
          subprocess.kill();
        }
      }
      resolve();
    });

    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const text = event.event.delta?.text || "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [
            {
              index: 0,
              delta: {
                role: isFirst ? ("assistant" as const) : undefined,
                content: text,
              },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
      }
    });

    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    });

    subprocess.on("result", (_result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        const doneChunk = createDoneChunk(requestId, lastModel);
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: error.message,
              type: "server_error",
              code: null,
            },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: `Process exited with code ${code}`,
                type: "server_error",
                code: null,
              },
            })}\n\n`
          );
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  _inflight: InflightRequest,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        res.json(cliResultToOpenai(finalResult, requestId));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Dedup handlers — piggyback on an existing subprocess via InflightRequest
// ---------------------------------------------------------------------------

/**
 * Handle streaming response for a deduped (piggybacking) request.
 * Listens on the InflightRequest emitter instead of a subprocess.
 */
async function handleDedupStreamingResponse(
  res: Response,
  inflight: InflightRequest,
  requestId: string
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Dedup", "true");
  res.flushHeaders();
  res.write(":ok\n\n");

  return new Promise<void>((resolve) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;

    const onContentDelta = (event: ClaudeCliStreamEvent) => {
      const text = event.event.delta?.text || "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [
            {
              index: 0,
              delta: {
                role: isFirst ? ("assistant" as const) : undefined,
                content: text,
              },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
      }
    };

    const onAssistant = (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    };

    const onResult = (_result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        const doneChunk = createDoneChunk(requestId, lastModel);
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: error.message,
              type: "server_error",
              code: null,
            },
          })}\n\n`
        );
        res.end();
      }
      cleanup();
      resolve();
    };

    const onClose = (code: number | null) => {
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: `Process exited with code ${code}`,
                type: "server_error",
                code: null,
              },
            })}\n\n`
          );
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      cleanup();
      resolve();
    };

    const cleanup = () => {
      inflight.off("content_delta", onContentDelta);
      inflight.off("assistant", onAssistant);
      inflight.off("result", onResult);
      inflight.off("subprocess_error", onError);
      inflight.off("close", onClose);
    };

    // Replay any buffered events from the subprocess that already fired
    inflight.replay((event, ...args) => {
      switch (event) {
        case "content_delta":
          onContentDelta(args[0] as ClaudeCliStreamEvent);
          break;
        case "assistant":
          onAssistant(args[0] as ClaudeCliAssistant);
          break;
        case "result":
          onResult(args[0] as ClaudeCliResult);
          break;
        case "subprocess_error":
          onError(args[0] as Error);
          break;
        case "close":
          onClose(args[0] as number | null);
          break;
      }
    });

    // If replay already completed the response, don't attach live listeners
    if (isComplete || res.writableEnded) return;

    inflight.on("content_delta", onContentDelta);
    inflight.on("assistant", onAssistant);
    inflight.on("result", onResult);
    inflight.on("subprocess_error", onError);
    inflight.on("close", onClose);

    // If client disconnects, clean up listeners
    res.on("close", () => {
      cleanup();
      resolve();
    });
  });
}

/**
 * Handle non-streaming response for a deduped request.
 */
async function handleDedupNonStreamingResponse(
  res: Response,
  inflight: InflightRequest,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;

    const onResult = (result: ClaudeCliResult) => {
      finalResult = result;
    };

    const onError = (error: Error) => {
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
      }
      cleanup();
      resolve();
    };

    const onClose = (code: number | null) => {
      if (finalResult) {
        res.json(cliResultToOpenai(finalResult, requestId));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      cleanup();
      resolve();
    };

    const cleanup = () => {
      inflight.off("result", onResult);
      inflight.off("subprocess_error", onError);
      inflight.off("close", onClose);
    };

    // Replay buffered events
    inflight.replay((event, ...args) => {
      switch (event) {
        case "result":
          onResult(args[0] as ClaudeCliResult);
          break;
        case "subprocess_error":
          onError(args[0] as Error);
          break;
        case "close":
          onClose(args[0] as number | null);
          break;
      }
    });

    if (res.headersSent) {
      cleanup();
      resolve();
      return;
    }

    inflight.on("result", onResult);
    inflight.on("subprocess_error", onError);
    inflight.on("close", onClose);
  });
}

// ---------------------------------------------------------------------------
// Static endpoints
// ---------------------------------------------------------------------------

/**
 * Handle GET /v1/models
 */
export function handleModels(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: [
      {
        id: "claude-opus-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-sonnet-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-haiku-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
    ],
  });
}

/**
 * Handle GET /health
 *
 * Returns pool and dedup stats for observability.
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
    pool: pool.stats(),
    dedup: dedupCache.stats(),
  });
}
