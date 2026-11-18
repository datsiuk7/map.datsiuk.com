const abortError = () => new DOMException('Aborted', 'AbortError');

// Bounded cache with shared in-flight requests and independent cancellation.
export class ResourceCache {
  constructor({ maxEntries = 16, ttl = 1200000, storage = null, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.ttl = ttl;
    this.storage = storage;
    this.now = now;
    this.entries = new Map();
    this.jobs = new Map();
  }
  remember(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
  get(key, loader, { signal, force = false, ttl = this.ttl } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    const cached = this.entries.get(key);
    if (!force && cached?.expiresAt > this.now()) {
      this.remember(key, cached);
      return Promise.resolve(cached.value);
    }
    if (force) this.delete(key);
    let job = this.jobs.get(key);
    if (!job) {
      job = { controller: new AbortController(), consumers: 0, settled: false };
      this.jobs.set(key, job);
      job.promise = (async () => {
        let stored;
        if (!force) {
          try { stored = await this.storage?.get(key); } catch { /* Storage is optional. */ }
        }
        if (job.controller.signal.aborted) throw abortError();
        if (stored?.expiresAt > this.now()) {
          this.remember(key, stored);
          return stored.value;
        }
        const value = await loader(job.controller.signal);
        if (job.controller.signal.aborted) throw abortError();
        const entry = { value, expiresAt: this.now() + ttl, updatedAt: this.now() };
        this.remember(key, entry);
        const save = () => Promise.resolve().then(() => this.storage?.put(key, entry)).catch(() => {});
        if (this.storage && typeof globalThis.requestIdleCallback === 'function') requestIdleCallback(save, { timeout: 1500 });
        else save();
        return value;
      })().finally(() => {
        job.settled = true;
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      });
    }
    job.consumers += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        job.consumers -= 1;
        if (!job.consumers && !job.settled) {
          job.controller.abort();
          if (this.jobs.get(key) === job) this.jobs.delete(key);
        }
        callback(value);
      };
      const abort = () => finish(reject, abortError());
      signal?.addEventListener('abort', abort, { once: true });
      job.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  delete(key) {
    this.entries.delete(key);
    this.jobs.get(key)?.controller.abort();
    this.jobs.delete(key);
    Promise.resolve().then(() => this.storage?.delete(key)).catch(() => {});
  }
}

let database;
function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (!database) database = new Promise(resolve => {
    const request = indexedDB.open('datsiuk-map-cache', 2);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains('resources')
        ? request.transaction.objectStore('resources')
        : request.result.createObjectStore('resources', { keyPath: 'key' });
      if (!store.indexNames.contains('usage')) store.createIndex('usage', ['namespace', 'updatedAt']);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = request.onblocked = () => resolve(null);
  });
  return database;
}

export function persistentStore(namespace, maxEntries) {
  const prefix = `${namespace}:`;
  return {
    async get(key) {
      const db = await openDatabase();
      if (!db) return undefined;
      return new Promise(resolve => {
        const request = db.transaction('resources').objectStore('resources').get(prefix + key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
      });
    },
    async put(key, entry) {
      const db = await openDatabase();
      if (!db) return;
      await new Promise(resolve => {
        const transaction = db.transaction('resources', 'readwrite');
        const store = transaction.objectStore('resources');
        store.put({ ...entry, key: prefix + key, namespace });
        // Evict by indexed keys, without cloning every large cached archive.
        const request = store.index('usage').openKeyCursor(IDBKeyRange.bound([namespace, 0], [namespace, Infinity]), 'prev');
        let count = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (++count > maxEntries) store.delete(cursor.primaryKey);
          cursor.continue();
        };
        transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
      });
    },
    async delete(key) {
      const db = await openDatabase();
      if (db) db.transaction('resources', 'readwrite').objectStore('resources').delete(prefix + key);
    }
  };
}

// Earlier builds persisted credentialed TileJSON URLs. Remove only those entries.
export async function purgeLegacyCredentialMetadata() {
  const db = await openDatabase();
  if (!db) return;
  await new Promise(resolve => {
    const transaction = db.transaction('resources', 'readwrite');
    const store = transaction.objectStore('resources');
    const request = store.openKeyCursor(IDBKeyRange.bound('metadata:basemap:', 'metadata:basemap:\uffff'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
  });
}

export function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function frameTask(callback, requestFrame = requestAnimationFrame) {
  let frame = null, latest;
  return (...args) => {
    latest = args;
    if (frame !== null) return;
    frame = requestFrame(() => { frame = null; callback(...latest); });
  };
}
