/**
 * Durable key/value storage for GitHub API data, backed by IndexedDB.
 *
 * IndexedDB keeps reads off the startup path (unlike localStorage, which had
 * to be parsed in full on load) and holds far more data. Writes are queued and
 * flushed in one transaction per tick; reads see queued writes immediately.
 */

export interface PersistedEntry<T = unknown> {
  data: T;
  timestamp: number;
}

export interface PersistentStore {
  get<T>(key: string): Promise<PersistedEntry<T> | undefined>;
  set(key: string, entry: PersistedEntry): void;
  deleteWhere(match: (key: string) => boolean): void;
  clear(): void;
}

/** In-memory store with the same semantics; used when IndexedDB is missing. */
export class MemoryPersistentStore implements PersistentStore {
  private entries = new Map<string, PersistedEntry>();

  async get<T>(key: string) {
    return this.entries.get(key) as PersistedEntry<T> | undefined;
  }

  set(key: string, entry: PersistedEntry) {
    this.entries.set(key, entry);
  }

  deleteWhere(match: (key: string) => boolean) {
    for (const key of this.entries.keys()) {
      if (match(key)) this.entries.delete(key);
    }
  }

  clear() {
    this.entries.clear();
  }
}

const DB_NAME = "pulldash-cache";
const DB_VERSION = 1;
const STORE_NAME = "entries";
// Entries nobody has refreshed in this long are dropped on startup.
const MAX_ENTRY_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

class IndexedDBStore implements PersistentStore {
  private db: Promise<IDBDatabase | null>;
  private queued = new Map<string, PersistedEntry>();
  private flushScheduled = false;

  constructor() {
    this.db = new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE_NAME);
        store.createIndex("timestamp", "timestamp");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    void this.prune();
  }

  async get<T>(key: string): Promise<PersistedEntry<T> | undefined> {
    const queued = this.queued.get(key);
    if (queued) return queued as PersistedEntry<T>;
    const db = await this.db;
    if (!db) return undefined;
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      return (await promisify(tx.objectStore(STORE_NAME).get(key))) as
        | PersistedEntry<T>
        | undefined;
    } catch {
      return undefined;
    }
  }

  set(key: string, entry: PersistedEntry) {
    this.queued.set(key, entry);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => void this.flush(), 0);
  }

  deleteWhere(match: (key: string) => boolean) {
    for (const key of this.queued.keys()) {
      if (match(key)) this.queued.delete(key);
    }
    // Transactions on the same store run in creation order, so reads issued
    // after this call never observe the deleted entries.
    void this.withStore("readwrite", (store) => {
      const request = store.openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (match(String(cursor.key))) store.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  }

  clear() {
    this.queued.clear();
    void this.withStore("readwrite", (store) => store.clear());
  }

  private async flush() {
    this.flushScheduled = false;
    const entries = [...this.queued];
    if (entries.length === 0) return;
    const db = await this.db;
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const [key, entry] of entries) store.put(entry, key);
    } catch {
      // Quota or serialization errors: the in-memory cache still works.
    } finally {
      // Reads issued from here on queue behind this transaction. A newer
      // write to the same key replaced the map entry and must stay queued.
      for (const [key, entry] of entries) {
        if (this.queued.get(key) === entry) this.queued.delete(key);
      }
    }
  }

  private async prune() {
    await this.withStore("readwrite", (store) => {
      const cutoff = IDBKeyRange.upperBound(Date.now() - MAX_ENTRY_AGE_MS);
      const request = store.index("timestamp").openKeyCursor(cutoff);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  }

  private async withStore(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => void
  ) {
    const db = await this.db;
    if (!db) return;
    try {
      run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
    } catch {
      // Ignore storage errors
    }
  }
}

export function openPersistentStore(): PersistentStore {
  if (typeof indexedDB === "undefined") return new MemoryPersistentStore();
  return new IndexedDBStore();
}
