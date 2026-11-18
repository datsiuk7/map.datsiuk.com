const STORAGE_KEY = 'map-provider-health-v1';
const PHASES = new Set(['catalog', 'imagery', 'probe']);

export class ProviderHealth {
  constructor({ storage = null, ttl = 900000, now = Date.now } = {}) {
    this.storage = storage;
    this.ttl = ttl;
    this.now = now;
    this.records = new Map();
    this.versions = new Map();
    this.listeners = new Set();
    this.lastSavedAt = 0;
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}');
      for (const [source, record] of Object.entries(saved)) {
        if (!record || !Number.isFinite(record.checkedAt) || record.checkedAt + ttl <= now()) continue;
        const errors = Object.fromEntries(Object.entries(record.errors || {}).filter(([phase, message]) => PHASES.has(phase) && typeof message === 'string'));
        this.records.set(source, { checkedAt: record.checkedAt, errors });
      }
    } catch { /* A blocked or malformed cache must not affect the map. */ }
  }
  get(source) {
    const record = this.records.get(source);
    return record && record.checkedAt + this.ttl > this.now() ? record : null;
  }
  revision(source) { return this.versions.get(source) || 0; }
  unavailable(source) { return Boolean(Object.keys(this.get(source)?.errors || {}).length); }
  needsCheck(source) { return !this.get(source); }
  message(source) { return Object.values(this.get(source)?.errors || {}).join(' · '); }
  subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  update(source, phase, message) {
    if (!PHASES.has(phase)) return;
    const previous = this.get(source);
    const errors = { ...(previous?.errors || {}) };
    if (message) errors[phase] = String(message).slice(0, 500);
    else {
      delete errors[phase];
      if (phase === 'imagery') delete errors.probe; // A real image is stronger evidence than a HEAD check.
    }
    this.records.set(source, { checkedAt: this.now(), errors });
    this.versions.set(source, this.revision(source) + 1);
    const changed = !previous || JSON.stringify(previous.errors) !== JSON.stringify(errors);
    if (changed || this.now() - this.lastSavedAt >= 60000) {
      try {
        const fresh = [...this.records].filter(([, value]) => value.checkedAt + this.ttl > this.now());
        this.storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(fresh)));
        this.lastSavedAt = this.now();
      } catch { /* Statuses still work in memory. */ }
    }
    if (changed) for (const callback of this.listeners) callback(source);
  }
  failure(source, phase, message) { this.update(source, phase, message || 'Останній запит не вдався'); }
  success(source, phase) { this.update(source, phase, null); }
  forget(source) {
    this.records.delete(source);
    this.versions.set(source, this.revision(source) + 1);
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.records))); } catch { /* Memory remains authoritative. */ }
    for (const callback of this.listeners) callback(source);
  }
}

export function providerLabel(label, unavailable) {
  const clean = label.replace(/\s*❌$/u, '');
  return unavailable ? `${clean} ❌` : clean;
}
