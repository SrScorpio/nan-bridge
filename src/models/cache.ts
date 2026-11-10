/**
 * TTL cache with single-flight refresh: concurrent callers share one load, a
 * `clear()` during a refresh discards its result. VS Code resolves every
 * provider entry at once, so without single-flight the refresh would fan out
 * into duplicate `/models` calls.
 */

export class TTLCache<T> {
  private value: T | undefined;
  private stampedAt = 0;
  private generation = 0;
  private pending: Promise<T> | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  clear(): void {
    this.generation += 1;
    this.value = undefined;
    this.stampedAt = 0;
    this.pending = undefined;
  }

  async getOrRefresh(
    maxAgeMs: number,
    load: () => Promise<T>,
    isCancellation: (error: unknown) => boolean = () => false,
  ): Promise<T> {
    if (this.value !== undefined && this.now() - this.stampedAt < maxAgeMs) return this.value;
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = (async () => {
      try {
        const value = await load();
        if (this.generation !== generation) {
          throw new Error("Catalog changed during refresh; dropping stale load");
        }
        this.value = value;
        this.stampedAt = this.now();
        return value;
      } catch (error) {
        if (this.generation !== generation) throw error;
        // Keep serving the last good catalog on refresh failure.
        if (this.value !== undefined && !isCancellation(error)) return this.value;
        throw error;
      } finally {
        if (this.generation === generation) this.pending = undefined;
      }
    })();
    return this.pending;
  }
}
