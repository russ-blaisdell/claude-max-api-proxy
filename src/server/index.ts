/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */

import crypto from "crypto";
import express, { Express, Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";
import { handleChatCompletions, handleModels, handleHealth } from "./routes.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;

// ---------------------------------------------------------------------------
// API Key — use CLAUDE_PROXY_API_KEY env var or generate a random key once
// ---------------------------------------------------------------------------
const API_KEY: string =
  process.env.CLAUDE_PROXY_API_KEY || crypto.randomBytes(32).toString("hex");

/** Return the active API key (used by standalone startup and plugin config). */
export function getApiKey(): string {
  return API_KEY;
}

// ---------------------------------------------------------------------------
// Rate limiting — simple per-IP sliding window, no extra dependencies
// ---------------------------------------------------------------------------
const RATE_LIMIT_RPM = Math.max(1, parseInt(process.env.RATE_LIMIT_RPM || "300", 10));
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  if (entry.count >= RATE_LIMIT_RPM) {
    return false;
  }

  entry.count++;
  return true;
}

// Clean up stale rate-limit entries every 5 minutes to avoid memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60_000).unref();

// ---------------------------------------------------------------------------
// Middleware helpers
// ---------------------------------------------------------------------------

/**
 * Require a valid Bearer API key on all routes except /health.
 */
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health") {
    next();
    return;
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({
      error: {
        message: "Missing API key. Provide: Authorization: Bearer <key>",
        type: "authentication_error",
        code: "missing_api_key",
      },
    });
    return;
  }

  const token = auth.slice(7);
  // Constant-time comparison to prevent timing attacks
  const expected = Buffer.from(API_KEY);
  const provided = Buffer.from(token);
  const valid =
    expected.length === provided.length &&
    crypto.timingSafeEqual(expected, provided);

  if (!valid) {
    res.status(401).json({
      error: {
        message: "Invalid API key",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
    return;
  }

  next();
}

/**
 * Enforce per-IP rate limit (RATE_LIMIT_RPM requests per minute).
 */
function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health") {
    next();
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(ip)) {
    res.setHeader("Retry-After", "5");
    res.status(429).json({
      error: {
        message: `Rate limit exceeded. Max ${RATE_LIMIT_RPM} requests per minute.`,
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });
    return;
  }

  next();
}

/**
 * Create and configure the Express app
 */
function createApp(): Express {
  const app = express();

  // Body parsing
  app.use(express.json({ limit: "10mb" }));

  // Request logging (debug mode)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS — opt-in via CORS_ORIGIN env var; defaults to disabled.
  // A wildcard origin would allow any browser tab to call this local server
  // and abuse your Claude Max subscription without your knowledge.
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      next();
    });

    app.options("*", (_req: Request, res: Response) => {
      res.sendStatus(200);
    });
  }

  // Security middleware
  app.use(requireApiKey);
  app.use(rateLimitMiddleware);

  // Routes
  app.get("/health", handleHealth);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", handleChatCompletions);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Server Error]:", err.message);
    res.status(500).json({
      error: {
        message: err.message,
        type: "server_error",
        code: null,
      },
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;

  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  const app = createApp();

  return new Promise((resolve, reject) => {
    serverInstance = createServer(app);

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.listen(port, host, () => {
      console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
      console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
      resolve(serverInstance!);
    });
  });
}

/**
 * Stop the HTTP server
 */
export async function stopServer(): Promise<void> {
  if (!serverInstance) {
    return;
  }

  return new Promise((resolve, reject) => {
    serverInstance!.close((err) => {
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        serverInstance = null;
        resolve();
      }
    });
  });
}

/**
 * Get the current server instance
 */
export function getServer(): Server | null {
  return serverInstance;
}
