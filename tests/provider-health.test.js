import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderHealth, providerLabel } from '../assets/provider-health.js';

const storage = () => {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
};

test('a failed imagery request is marked, survives reload, and is cleared by a real image', () => {
  const store = storage();
  const health = new ProviderHealth({ storage: store, now: () => 100 });
  health.failure('mapbox', 'imagery', 'Mapbox: HTTP 429');
  assert.equal(health.unavailable('mapbox'), true);
  assert.equal(health.message('mapbox'), 'Mapbox: HTTP 429');
  const reloaded = new ProviderHealth({ storage: store, now: () => 101 });
  assert.equal(reloaded.unavailable('mapbox'), true);
  reloaded.success('mapbox', 'imagery');
  assert.equal(reloaded.unavailable('mapbox'), false);
  assert.equal(new ProviderHealth({ storage: store, now: () => 102 }).unavailable('mapbox'), false);
});

test('a successful static catalog does not hide a tile outage', () => {
  const health = new ProviderHealth();
  health.failure('mapbox', 'probe', '429');
  health.failure('mapbox', 'imagery', '429');
  health.success('mapbox', 'catalog');
  assert.equal(health.unavailable('mapbox'), true);
  health.success('mapbox', 'probe');
  assert.equal(health.unavailable('mapbox'), true);
  health.success('mapbox', 'imagery');
  assert.equal(health.unavailable('mapbox'), false);
});

test('images remain separate from catalog failures until the catalog recovers', () => {
  const health = new ProviderHealth();
  health.failure('landsat', 'catalog', 'Список дат недоступний');
  health.success('landsat', 'imagery');
  assert.equal(health.unavailable('landsat'), true);
  health.success('landsat', 'catalog');
  assert.equal(health.unavailable('landsat'), false);
});

test('stale availability is not treated as a permanent provider ban', () => {
  let time = 100;
  const store = storage();
  const health = new ProviderHealth({ storage: store, now: () => time, ttl: 10 });
  health.failure('mapbox', 'imagery', '429');
  time = 109;
  assert.equal(health.unavailable('mapbox'), true);
  time = 110;
  assert.equal(health.needsCheck('mapbox'), true);
  assert.equal(health.unavailable('mapbox'), false);
  assert.equal(new ProviderHealth({ storage: store, now: () => time, ttl: 10 }).unavailable('mapbox'), false);
});

test('newer real images invalidate an older background check result', () => {
  const health = new ProviderHealth();
  const beforeProbe = health.revision('maptiler');
  health.success('maptiler', 'imagery');
  assert.notEqual(health.revision('maptiler'), beforeProbe);
  assert.equal(health.unavailable('maptiler'), false);
});

test('repeated successful tile events do not repeatedly redraw labels or write storage', () => {
  let writes = 0, changes = 0;
  const health = new ProviderHealth({ now: () => 100, storage: { getItem: () => null, setItem: () => { writes++; } } });
  health.subscribe(() => { changes++; });
  for (let index = 0; index < 100; index++) health.success('esri-live', 'imagery');
  assert.equal(changes, 1);
  assert.equal(writes, 1);
  health.failure('esri-live', 'imagery', 'offline');
  assert.equal(changes, 2);
  assert.equal(writes, 2);
});

test('blocked and malformed browser storage do not break availability indicators', () => {
  const malformed = new ProviderHealth({ storage: { getItem: () => '{bad json', setItem() {} } });
  assert.equal(malformed.needsCheck('esri'), true);
  const blocked = new ProviderHealth({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  blocked.failure('mapbox', 'imagery', '429');
  assert.equal(blocked.unavailable('mapbox'), true);
});

test('provider labels do not accumulate crosses and retain their original names', () => {
  assert.equal(providerLabel('Mapbox Satellite', true), 'Mapbox Satellite ❌');
  assert.equal(providerLabel('Mapbox Satellite ❌', true), 'Mapbox Satellite ❌');
  assert.equal(providerLabel('Mapbox Satellite ❌', false), 'Mapbox Satellite');
});

test('changing a visitor key forgets its old outage and invalidates pending checks', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const health = new ProviderHealth({ storage });
  health.failure('mapbox', 'imagery', 'HTTP 429');
  const oldRevision = health.revision('mapbox');
  health.forget('mapbox');
  assert.equal(health.unavailable('mapbox'), false);
  assert.equal(health.needsCheck('mapbox'), true);
  assert.ok(health.revision('mapbox') > oldRevision);
  assert.equal(new ProviderHealth({ storage }).unavailable('mapbox'), false);
});
