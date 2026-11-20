import { ApiError } from '@wasit/shared';

/**
 * A small counting semaphore (011.4) that bounds how many expensive operations
 * run at once in a process.
 *
 * It is used to cap concurrent marketing-video renders: each render is a
 * synchronous, CPU/memory-heavy ffmpeg pass, so an unbounded burst would spawn
 * as many ffmpeg processes as there are requests. A waiter queues for a slot and
 * is shed with a 503 if none frees within `timeoutMs` — a live render is never
 * killed mid-flight, so a legitimate request is either served or told to retry.
 *
 * The cap is per-process: with several replicas each holds its own budget, which
 * is the right granularity for a CPU-bound local renderer (the shared limiter
 * already bounds the request rate across replicas).
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private readonly capacity: number) {
    this.available = capacity;
  }

  /** Slots currently free (for tests/metrics). */
  get free(): number {
    return this.available;
  }

  /** Waiters queued for a slot (for tests/metrics). */
  get waiting(): number {
    return this.waiters.length;
  }

  /** Acquires a slot, or throws 503 when none frees within `timeoutMs`. */
  async acquire(timeoutMs: number): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          reject(ApiError.serviceUnavailable('Server is busy; please retry shortly'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Releases a slot, handing it directly to the next waiter when present. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
      return;
    }
    if (this.available < this.capacity) this.available += 1;
  }

  /** Runs `fn` while holding a slot. */
  async run<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
