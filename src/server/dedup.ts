/**
 * Request Deduplication
 *
 * When multiple identical requests arrive concurrently (same prompt + model),
 * only one subprocess is spawned. Additional callers fan-out from the same
 * subprocess event stream and receive identical responses.
 *
 * This is common when OpenClaw sub-agents retry or when duplicate webhook
 * deliveries hit the proxy simultaneously.
 */

import crypto from "crypto";
import { EventEmitter } from "events";

export interface DedupStats {
  inflight: number;
  totalDeduped: number;
}

/** Buffered event so late joiners can catch up. */
interface BufferedEvent {
  event: string;
  args: unknown[];
}

/**
 * An in-flight request that may have multiple consumers.
 * New consumers attach to the emitter and receive the same events.
 */
class InflightRequest extends EventEmitter {
  public readonly key: string;
  public refCount = 0;
  public completed = false;
  private buffer: BufferedEvent[] = [];

  constructor(key: string) {
    super();
    this.setMaxListeners(50); // support many concurrent consumers
    this.key = key;
  }

  /** Record an event and replay it to future joiners. */
  emitBuffered(event: string, ...args: unknown[]): void {
    this.buffer.push({ event, args });
    this.emit(event, ...args);
  }

  /** Replay all buffered events to a new listener. */
  replay(listener: (event: string, ...args: unknown[]) => void): void {
    for (const entry of this.buffer) {
      listener(entry.event, ...entry.args);
    }
  }
}

const DEDUP_WINDOW_MS = Math.max(
  500,
  parseInt(process.env.DEDUP_WINDOW_MS || "2000", 10)
);

class DedupCache {
  private inflight = new Map<string, InflightRequest>();
  private totalDeduped = 0;

  /**
   * Build a cache key from the prompt and model.
   * Only exact duplicates within the time window are deduped.
   */
  static makeKey(prompt: string, model: string): string {
    const hash = crypto
      .createHash("sha256")
      .update(`${model}:${prompt}`)
      .digest("hex")
      .slice(0, 16);
    return hash;
  }

  /**
   * Check if an identical request is already in-flight.
   * Returns the existing InflightRequest if so, or null if this is new.
   */
  get(key: string): InflightRequest | null {
    const existing = this.inflight.get(key);
    if (existing && !existing.completed) {
      this.totalDeduped++;
      existing.refCount++;
      return existing;
    }
    return null;
  }

  /**
   * Register a new in-flight request.
   * The caller is responsible for emitting events on the returned object.
   */
  register(key: string): InflightRequest {
    const entry = new InflightRequest(key);
    entry.refCount = 1;
    this.inflight.set(key, entry);

    // Auto-cleanup after the dedup window + a generous grace period
    // to handle slow consumers
    const cleanup = () => {
      entry.completed = true;
      // Keep the entry briefly so very-late duplicates still dedup
      setTimeout(() => {
        if (this.inflight.get(key) === entry) {
          this.inflight.delete(key);
        }
      }, DEDUP_WINDOW_MS).unref();
    };

    entry.on("done", cleanup);
    entry.on("error", cleanup);

    return entry;
  }

  stats(): DedupStats {
    return {
      inflight: this.inflight.size,
      totalDeduped: this.totalDeduped,
    };
  }
}

// Singleton
export const dedupCache = new DedupCache();
export { DedupCache, InflightRequest };
