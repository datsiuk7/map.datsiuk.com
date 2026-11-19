const STORAGE_KEY = 'datsiuk-map-credentials-v1';
export const KEY_SOURCES = ['maptiler', 'mapbox'];

export function validateKey(source, value) {
  if (!KEY_SOURCES.includes(source)) throw new Error('Невідомий сервіс.');
  const key = String(value || '').trim();
  if (!key) return '';
  if (key.length > 1024 || /\s|[<>"'`]/u.test(key)) throw new Error('Вставте лише ключ, без пробілів, лапок або адреси сайту.');
  if (source === 'mapbox' && !key.startsWith('pk.')) throw new Error('Для Mapbox потрібен публічний токен pk., який дозволено використовувати у браузері.');
  if (/[/?#]/.test(key)) throw new Error('Вставте сам ключ, а не посилання.');
  return key;
}

export class CredentialStore {
  constructor({ session = null, local = null } = {}) {
    this.session = session;
    this.local = local;
    this.keys = {};
    this.versions = {};
    this.listeners = new Set();
    this.remember = false;
    this.storageMode = 'memory';
    for (const [storage, mode] of [[local, 'local'], [session, 'session']]) {
      try {
        const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
        if (saved?.version !== 1 || !saved.keys || typeof saved.keys !== 'object') continue;
        const keys = {};
        for (const source of KEY_SOURCES) {
          try { keys[source] = validateKey(source, saved.keys[source]); } catch { keys[source] = ''; }
        }
        this.keys = keys;
        this.remember = mode === 'local';
        this.storageMode = mode;
        // Drop keys of services the site no longer uses (the former Gamma Earth key).
        if (Object.keys(saved.keys).some(source => !KEY_SOURCES.includes(source))) {
          try {
            if (KEY_SOURCES.some(source => keys[source])) storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, keys }));
            else { storage.removeItem(STORAGE_KEY); this.remember = false; this.storageMode = 'memory'; }
          } catch { /* The stale entry is ignored either way. */ }
        }
        break;
      } catch { /* A blocked or malformed store leaves the map usable. */ }
    }
  }
  get(source) { return KEY_SOURCES.includes(source) ? this.keys[source] || '' : ''; }
  revision(source) { return this.versions[source] || 0; }
  subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  setAll(values = {}, { remember = false } = {}) {
    const next = Object.fromEntries(KEY_SOURCES.map(source => [source, validateKey(source, values[source])]));
    const changed = KEY_SOURCES.filter(source => this.get(source) !== next[source]);
    // Validate all values before replacing any current credentials.
    this.keys = next;
    this.remember = remember && KEY_SOURCES.some(source => next[source]);
    this.storageMode = 'memory';
    let cleared = true;
    for (const storage of [this.session, this.local]) {
      try { storage?.removeItem(STORAGE_KEY); } catch { cleared = false; }
    }
    if (KEY_SOURCES.some(source => next[source])) {
      const storage = this.remember ? this.local : this.session;
      try {
        if (storage) {
          storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, keys: next }));
          this.storageMode = this.remember ? 'local' : 'session';
        }
      } catch { /* Keys can still be used until this page is closed. */ }
    }
    if (this.storageMode !== 'local') this.remember = false;
    for (const source of changed) this.versions[source] = this.revision(source) + 1;
    if (changed.length) for (const callback of this.listeners) callback(changed);
    return { changed, mode: this.storageMode, cleared };
  }
  clear() { return this.setAll({}); }
}

function storage(name) { try { return globalThis[name] || null; } catch { return null; } }
export const credentials = new CredentialStore({ session: storage('sessionStorage'), local: storage('localStorage') });

export function redactSecrets(message, keys = []) {
  let text = String(message || '');
  for (const key of keys.filter(Boolean)) {
    text = text.split(key).join('[ключ приховано]').split(encodeURIComponent(key)).join('[ключ приховано]');
  }
  return text.replace(/([?&](?:key|access_token)=)[^\s&#]+/gi, '$1[приховано]').slice(0, 500);
}
