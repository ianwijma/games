/** Where seat tokens live so a reload can rejoin. Synchronous string key/value. */
export interface TokenStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Keeps tokens in memory only (tests, one-off sessions). */
export function memoryStorage(): TokenStorage {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

/** Keeps tokens in localStorage (or any `Storage`). Never throws: private modes may block storage. */
export function browserStorage(storage?: Storage): TokenStorage {
  const use = <T>(fn: (s: Storage) => T, fallback: T): T => {
    try {
      const s = storage ?? globalThis.localStorage;
      return s ? fn(s) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    get: (key) => use((s) => s.getItem(key), null),
    set: (key, value) => use((s) => s.setItem(key, value), undefined),
    remove: (key) => use((s) => s.removeItem(key), undefined),
  };
}
