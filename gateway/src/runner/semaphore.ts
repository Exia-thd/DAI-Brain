/**
 * A counting semaphore with a queue.
 *
 * Each permit is a whole Claude CLI process: its own node runtime, its own MCP
 * connections, its own memory. Unbounded spawning does not degrade gracefully,
 * it takes the host down -- so requests wait here instead, and a caller that
 * gives up while waiting releases its place rather than holding it.
 */
export class Semaphore {
  private inUse = 0;
  private readonly waiting: { resolve: () => void; reject: (err: Error) => void }[] = [];

  constructor(readonly limit: number) {
    if (limit < 1) throw new Error('semaphore limit must be at least 1');
  }

  get available(): number { return this.limit - this.inUse; }
  get queued(): number { return this.waiting.length; }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('cancelled while queued');
    if (this.inUse < this.limit) {
      this.inUse++;
      return this.releaser();
    }

    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      this.waiting.push(entry);
      signal?.addEventListener('abort', () => {
        const at = this.waiting.indexOf(entry);
        if (at !== -1) {
          this.waiting.splice(at, 1);
          reject(new Error('cancelled while queued'));
        }
      }, { once: true });
    });
    this.inUse++;
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      // Idempotent because the caller releases in a finally block and the
      // cancellation path may have released already; double-release would hand
      // out a permit that does not exist.
      if (released) return;
      released = true;
      this.inUse--;
      this.waiting.shift()?.resolve();
    };
  }
}
