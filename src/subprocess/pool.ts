/**
 * Subprocess Concurrency Pool
 *
 * Limits the number of concurrent Claude CLI subprocesses and queues
 * excess requests in FIFO order. Returns 503 when the queue is full
 * so upstream callers (OpenClaw) can retry via their own backoff logic.
 */

import { EventEmitter } from "events";

export interface PoolStats {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueueDepth: number;
  totalCompleted: number;
  totalFailed: number;
  totalRejected: number;
}

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

const MAX_CONCURRENT = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT || "3", 10)
);
const MAX_QUEUE_DEPTH = Math.max(
  0,
  parseInt(process.env.MAX_QUEUE_DEPTH || "20", 10)
);

// How long a queued request can wait before we reject it (default 2 min)
const QUEUE_TIMEOUT_MS = Math.max(
  5_000,
  parseInt(process.env.QUEUE_TIMEOUT_MS || "120000", 10)
);

class SubprocessPool extends EventEmitter {
  private active = 0;
  private queue: QueueEntry[] = [];
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalRejected = 0;
  private queueTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    // Periodically expire stale queue entries
    this.queueTimer = setInterval(() => this.expireStaleEntries(), 10_000);
    this.queueTimer.unref();
  }

  /**
   * Acquire a slot to run a subprocess.
   *
   * Resolves immediately if a slot is available, otherwise queues.
   * Throws if the queue is full (caller should return 503).
   */
  async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active++;
      return;
    }

    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      this.totalRejected++;
      throw new PoolFullError(this.active, this.queue.length);
    }

    // Wait for a slot
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject, enqueuedAt: Date.now() });
    });
  }

  /**
   * Release a slot after subprocess completes (success or failure).
   * Must be called exactly once per successful acquire().
   */
  release(succeeded: boolean): void {
    if (succeeded) {
      this.totalCompleted++;
    } else {
      this.totalFailed++;
    }

    // Drain the next queued request if any
    const next = this.queue.shift();
    if (next) {
      // Don't decrement active — hand the slot directly to the next waiter
      next.resolve();
    } else {
      this.active--;
    }
  }

  /** Current pool statistics for the /health endpoint. */
  stats(): PoolStats {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: MAX_CONCURRENT,
      maxQueueDepth: MAX_QUEUE_DEPTH,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalRejected: this.totalRejected,
    };
  }

  /** Reject queue entries that have waited too long. */
  private expireStaleEntries(): void {
    const now = Date.now();
    const expired: QueueEntry[] = [];

    this.queue = this.queue.filter((entry) => {
      if (now - entry.enqueuedAt > QUEUE_TIMEOUT_MS) {
        expired.push(entry);
        return false;
      }
      return true;
    });

    for (const entry of expired) {
      this.totalRejected++;
      entry.reject(
        new Error(`Queued request timed out after ${QUEUE_TIMEOUT_MS}ms`)
      );
    }
  }

  /** Shut down the pool, rejecting all queued requests. */
  shutdown(): void {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    for (const entry of this.queue) {
      entry.reject(new Error("Pool shutting down"));
    }
    this.queue = [];
  }
}

/**
 * Error thrown when the pool queue is full.
 * Routes should catch this and return 503.
 */
export class PoolFullError extends Error {
  public readonly active: number;
  public readonly queued: number;

  constructor(active: number, queued: number) {
    super(
      `Server busy: ${active} active subprocesses, ${queued} queued. Try again shortly.`
    );
    this.name = "PoolFullError";
    this.active = active;
    this.queued = queued;
  }
}

// Singleton
export const pool = new SubprocessPool();
