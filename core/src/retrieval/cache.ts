/**
 * A bounded TTL cache keyed by (scope, query, options).
 *
 * The scope is part of the key and is never optional. A cache keyed by query
 * alone is the cheapest possible cross-user leak, and it would pass every test
 * that runs as one user.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();

  constructor(private readonly ttlMs: number, private readonly max: number) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) { this.entries.delete(key); return undefined; }
    // Re-insert so iteration order is least-recently-used first.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}
