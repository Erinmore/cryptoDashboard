/**
 * In-memory TTL cache.
 * Cada entrada expira automáticamente pasado su TTL (segundos).
 */

const store = new Map();

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function cacheSet(key, value, ttlSeconds) {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

export function cacheHas(key) {
  return cacheGet(key) !== null;
}

export function cacheDelete(key) {
  store.delete(key);
}

export function cacheClear() {
  store.clear();
}

/** Tamaño actual del cache (incluyendo entradas expiradas no limpiadas aún) */
export function cacheSize() {
  return store.size;
}
