import type { PersistentStore } from "./persistent-cache";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export const DEFAULT_CACHE_TTL = 30_000; // 30 seconds

/**
 * Whether `key` belongs to `pattern`: the key itself or anything nested
 * under it. `pr:o/r/1` covers `pr:o/r/1:files` but not `pr:o/r/12`.
 */
export function cacheKeyMatches(key: string, pattern: string): boolean {
  return (
    key === pattern ||
    key.startsWith(`${pattern}:`) ||
    key.startsWith(`${pattern}/`)
  );
}

/**
 * Two-tier cache: synchronous in-memory entries for hot reads, plus an
 * optional durable copy so data survives reloads (stale-while-revalidate).
 */
export class RequestCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private pending = new Map<string, Promise<unknown>>();

  constructor(private persistent: PersistentStore) {}

  /**
   * Get cached data. Returns null if no cache or cache is stale.
   */
  get<T>(key: string, ttl = DEFAULT_CACHE_TTL): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > ttl) {
      // The durable copy (if any) stays around for peek().
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  /**
   * Get in-memory data even if stale (for SWR pattern).
   * Returns { data, isStale } or null if no cache exists.
   */
  getStale<T>(
    key: string,
    freshTtl = DEFAULT_CACHE_TTL
  ): { data: T; isStale: boolean } | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    const isStale = Date.now() - entry.timestamp > freshTtl;
    return { data: entry.data as T, isStale };
  }

  /**
   * Last known value regardless of age, from memory or durable storage.
   * Durable hits are promoted to memory with their original timestamp, so
   * freshness checks still treat them as old.
   */
  async peek<T>(key: string): Promise<CacheEntry<T> | null> {
    const memory = this.cache.get(key);
    if (memory) return memory as CacheEntry<T>;
    const stored = await this.persistent.get<T>(key);
    if (!stored) return null;
    // A fresher in-memory value may have landed while we were reading.
    const current = this.cache.get(key);
    if (current) return current as CacheEntry<T>;
    this.cache.set(key, stored);
    return stored;
  }

  set<T>(key: string, data: T, persist = false): void {
    const entry = { data, timestamp: Date.now() };
    this.cache.set(key, entry);
    if (persist) this.persistent.set(key, entry);
  }

  getPending<T>(key: string): Promise<T> | null {
    return (this.pending.get(key) as Promise<T> | undefined) ?? null;
  }

  setPending<T>(key: string, promise: Promise<T>): void {
    this.pending.set(key, promise);
    const clear = () => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    };
    promise.then(clear, clear);
  }

  clearPending(key: string): void {
    this.pending.delete(key);
  }

  /**
   * Drop entries for `pattern` (see cacheKeyMatches) or, with a function,
   * every key it accepts. No argument clears everything.
   */
  invalidate(pattern?: string | ((key: string) => boolean)): void {
    if (pattern === undefined) {
      this.cache.clear();
      this.pending.clear();
      this.persistent.clear();
      return;
    }
    const match =
      typeof pattern === "string"
        ? (key: string) => cacheKeyMatches(key, pattern)
        : pattern;
    for (const key of this.cache.keys()) {
      if (match(key)) this.cache.delete(key);
    }
    for (const key of this.pending.keys()) {
      if (match(key)) this.pending.delete(key);
    }
    this.persistent.deleteWhere(match);
  }
}
