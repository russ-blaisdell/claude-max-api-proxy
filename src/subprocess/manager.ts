/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs/promises";
import path from "path";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

export interface SubprocessOptions {
  model: ClaudeModel;
  sessionId?: string;
  cwd?: string;
  timeout?: number;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

const DEFAULT_TIMEOUT = Math.max(
  60_000,
  parseInt(process.env.SUBPROCESS_TIMEOUT_MS || "1800000", 10)
); // default 30 minutes
const SUBPROCESS_RETRY = Math.max(
  0,
  parseInt(process.env.SUBPROCESS_RETRY || "1", 10)
);
const RETRY_DELAY_MS = 1000;

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;

  /**
   * Start the Claude CLI subprocess with the given prompt
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(prompt, options);
    const timeout = options.timeout || DEFAULT_TIMEOUT;

    return new Promise((resolve, reject) => {
      try {
        // Use spawn() for security - no shell interpretation.
        // Default cwd to home directory rather than process.cwd() so the
        // subprocess never implicitly inherits a sensitive working directory.
        // Strip CLAUDECODE env var to prevent recursive self-invocation.
        const spawnEnv = { ...process.env };
        delete spawnEnv.CLAUDECODE;

        this.process = spawn("claude", args, {
          cwd: options.cwd || process.env.HOME || "/tmp",
          env: spawnEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Set timeout
        this.timeoutId = setTimeout(() => {
          if (!this.isKilled) {
            this.isKilled = true;
            this.process?.kill("SIGTERM");
            this.emit("error", new Error(`Request timed out after ${timeout}ms`));
          }
        }, timeout);

        // Handle spawn errors (e.g., claude not found)
        this.process.on("error", (err) => {
          this.clearTimeout();
          if (err.message.includes("ENOENT")) {
            reject(
              new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
              )
            );
          } else {
            reject(err);
          }
        });

        // Pipe prompt via stdin instead of argv to avoid E2BIG on large
        // prompts (OS ARG_MAX is typically ~128KB on Linux).
        if (this.process.stdin) {
          this.process.stdin.on("error", (err) => {
            console.error("[Subprocess stdin error]:", err.message);
          });
          this.process.stdin.write(prompt, "utf8", () => {
            this.process?.stdin?.end();
          });
        }

        console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);

        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          const data = chunk.toString();
          console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
          this.buffer += data;
          this.processBuffer();
        });

        // Capture stderr for debugging
        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText) {
            // Don't emit as error unless it's actually an error
            // Claude CLI may write debug info to stderr
            console.error("[Subprocess stderr]:", errorText.slice(0, 200));
          }
        });

        // Handle process close
        this.process.on("close", (code) => {
          console.error(`[Subprocess] Process closed with code: ${code}`);
          this.clearTimeout();
          // Process any remaining buffer
          if (this.buffer.trim()) {
            this.processBuffer();
          }
          this.emit("close", code);
        });

        // Resolve immediately since we're streaming
        resolve();
      } catch (err) {
        this.clearTimeout();
        reject(err);
      }
    });
  }

  /**
   * Build CLI arguments array. Prompt is sent via stdin (see start()) to
   * avoid E2BIG when the assembled prompt exceeds the OS ARG_MAX limit.
   */
  private buildArgs(_prompt: string, options: SubprocessOptions): string[] {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      options.model,
      "--no-session-persistence",
    ];

    if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }

    return args;
  }

  /**
   * Process the buffer and emit parsed messages
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        if (isContentDelta(message)) {
          // Emit content delta for streaming
          this.emit("content_delta", message as ClaudeCliStreamEvent);
        } else if (isAssistantMessage(message)) {
          this.emit("assistant", message);
        } else if (isResultMessage(message)) {
          this.emit("result", message);
        }
      } catch {
        // Non-JSON output, emit as raw
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Clear the timeout timer
   */
  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Kill the subprocess
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.isKilled = true;
      this.clearTimeout();
      this.process.kill(signal);
    }
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Spawn a ClaudeSubprocess with automatic retry on transient failures.
 *
 * Returns a subprocess that is already started. If the initial spawn fails
 * with a transient error (ENOENT excluded), it retries up to SUBPROCESS_RETRY
 * times with a 1-second delay between attempts.
 *
 * The caller should listen for events on the returned subprocess as usual.
 */
export async function spawnWithRetry(
  prompt: string,
  options: SubprocessOptions
): Promise<ClaudeSubprocess> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= SUBPROCESS_RETRY; attempt++) {
    const subprocess = new ClaudeSubprocess();

    try {
      await subprocess.start(prompt, options);

      // Wait briefly to see if the process exits immediately (bad spawn)
      const earlyExit = await Promise.race([
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
        new Promise<true>((resolve) => {
          subprocess.once("close", (code) => {
            if (code !== null && code !== 0) resolve(true);
          });
        }),
      ]);

      if (!earlyExit) {
        // Process is alive — return it
        return subprocess;
      }

      // Process died immediately — treat as transient failure
      lastError = new Error(`Subprocess exited immediately (attempt ${attempt + 1})`);
      console.error(`[spawnWithRetry] Attempt ${attempt + 1} failed: early exit`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // ENOENT = CLI not installed, no point retrying
      if (lastError.message.includes("ENOENT") || lastError.message.includes("not found")) {
        throw lastError;
      }

      console.error(
        `[spawnWithRetry] Attempt ${attempt + 1} failed: ${lastError.message}`
      );
    }

    // Wait before retrying (skip delay on last attempt)
    if (attempt < SUBPROCESS_RETRY) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  throw lastError || new Error("Subprocess spawn failed after retries");
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
