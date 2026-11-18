// Photo history kept in this browser (IndexedDB). Records hold only image blobs and
// descriptive metadata: tile URLs are never stored, because they may contain API keys.

export const HISTORY_LIMITS = Object.freeze({ maxEntries: 60, maxBytes: 400 * 1024 * 1024 });

// Newest photos are kept; the oldest go first once a limit is exceeded.
export function entriesToPrune(entries, { maxEntries, maxBytes } = HISTORY_LIMITS) {
  const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);
  const remove = [];
  let bytes = 0;
  sorted.forEach((entry, index) => {
    bytes += entry.bytes || 0;
    if (index > 0 && (index >= maxEntries || bytes > maxBytes)) remove.push(entry.id);
  });
  return remove;
}

export function createSnapshotStore({ indexedDB = globalThis.indexedDB, limits = HISTORY_LIMITS } = {}) {
  const memory = new Map();
  let database;
  const open = () => {
    if (!indexedDB) return Promise.resolve(null);
    if (!database) database = new Promise(resolve => {
      let request;
      try { request = indexedDB.open('datsiuk-map-photos', 1); } catch { resolve(null); return; }
      request.onupgradeneeded = () => request.result.createObjectStore('photos', { keyPath: 'id' });
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); database = undefined; };
        resolve(request.result);
      };
      request.onerror = request.onblocked = () => resolve(null);
    });
    return database;
  };
  const run = async (mode, action) => {
    const db = await open();
    if (!db) return action(null);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('photos', mode);
      let result;
      Promise.resolve(action(transaction.objectStore('photos'))).then(value => { result = value; }, reject);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Сховище браузера недоступне'));
    });
  };
  const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

  const store = {
    persistent: false,
    async list() {
      const items = await run('readonly', s => s ? request(s.getAll()) : [...memory.values()]);
      return items.sort((a, b) => b.createdAt - a.createdAt);
    },
    async get(id) {
      return run('readonly', s => s ? request(s.get(id)) : memory.get(id));
    },
    async save(entry) {
      const record = { ...entry, bytes: entry.blob?.size || 0 };
      await run('readwrite', s => s ? request(s.put(record)) : memory.set(record.id, record));
      const stale = entriesToPrune(await store.list(), limits);
      if (stale.length) await run('readwrite', s => { for (const id of stale) s ? s.delete(id) : memory.delete(id); });
      return { record, pruned: stale.length };
    },
    async remove(id) {
      await run('readwrite', s => s ? request(s.delete(id)) : memory.delete(id));
    },
    async clear() {
      await run('readwrite', s => s ? request(s.clear()) : memory.clear());
    }
  };
  open().then(db => { store.persistent = Boolean(db); });
  return store;
}
