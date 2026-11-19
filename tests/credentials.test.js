import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialStore, validateKey, redactSecrets } from '../assets/credentials.js';

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data };
}

test('visitor keys default to this tab and survive a reload without becoming device-wide', () => {
  const session = storage(), local = storage();
  const store = new CredentialStore({ session, local });
  assert.equal(store.get('maptiler'), '');
  assert.equal(store.setAll({ maptiler: 'visitor-key' }).mode, 'session');
  assert.equal(local.data.size, 0);
  assert.equal(new CredentialStore({ session, local }).get('maptiler'), 'visitor-key');
  assert.equal(new CredentialStore({ session: storage(), local }).get('maptiler'), '');
  assert.equal(store.get('__proto__'), '');
});

test('remembering requires an explicit opt-in and returning to tab storage removes the persistent copy', () => {
  const session = storage(), local = storage();
  const store = new CredentialStore({ session, local });
  store.setAll({ mapbox: 'pk.visitor-key' }, { remember: true });
  assert.equal(local.data.size, 1); assert.equal(session.data.size, 0);
  const reload = new CredentialStore({ session: storage(), local });
  assert.equal(reload.get('mapbox'), 'pk.visitor-key'); assert.equal(reload.remember, true);
  reload.setAll({ mapbox: 'pk.visitor-key' });
  assert.equal(local.data.size, 0); assert.equal(reload.remember, false);
});

test('forget clears both browser stores and notifies consumers to stop using the old keys', () => {
  const session = storage(), local = storage();
  const store = new CredentialStore({ session, local });
  store.setAll({ maptiler: 'visitor-key', mapbox: 'pk.visitor-token' }, { remember: true });
  let changed;
  store.subscribe(sources => { changed = sources; });
  const version = store.revision('maptiler');
  store.clear();
  assert.equal(store.get('maptiler'), ''); assert.equal(store.get('mapbox'), '');
  assert.equal(local.data.size + session.data.size, 0);
  assert.deepEqual(changed, ['maptiler', 'mapbox']);
  assert.equal(store.revision('maptiler'), version + 1);
});

test('invalid and secret Mapbox tokens are rejected atomically before other keys are replaced', () => {
  const store = new CredentialStore();
  store.setAll({ maptiler: 'original-key' });
  assert.throws(() => store.setAll({ maptiler: 'new-key', mapbox: 'sk.private-token' }), /публічний токен/);
  assert.equal(store.get('maptiler'), 'original-key');
  for (const value of ['two words', 'https://example.test/key', 'key<script>', 'a'.repeat(1025)]) assert.throws(() => validateKey('maptiler', value));
  assert.throws(() => validateKey('unknown', 'fixture'));
  assert.throws(() => validateKey('gamma', 'fixture'), /Невідомий/, 'Gamma Earth is no longer a key source');
  assert.equal(validateKey('maptiler', '  visitor-key  '), 'visitor-key');
});

test('blocked storage falls back to memory and malformed stored credentials do not break startup', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const store = new CredentialStore({ session: blocked, local: blocked });
  const result = store.setAll({ maptiler: 'maptiler-fixture' }, { remember: true });
  assert.equal(result.mode, 'memory'); assert.equal(result.cleared, false);
  assert.equal(store.get('maptiler'), 'maptiler-fixture'); assert.equal(store.remember, false);
  const malformed = storage(); malformed.setItem('datsiuk-map-credentials-v1', '{bad');
  assert.equal(new CredentialStore({ local: malformed }).get('mapbox'), '');
});

test('keys are removed from error text including encoded URLs', () => {
  const key = 'fixture+key';
  const message = redactSecrets(`Failed ${key} https://api.maptiler.com/tile?key=${encodeURIComponent(key)}&x=1` , [key]);
  assert.equal(message.includes(key), false); assert.equal(message.includes(encodeURIComponent(key)), false);
  assert.equal(redactSecrets('https://api.mapbox.com/tile?access_token=pk.fixture').includes('pk.fixture'), false);
});

test('a saved key of the removed Gamma Earth service is dropped from browser storage', () => {
  const local = storage();
  local.setItem('datsiuk-map-credentials-v1', JSON.stringify({ version: 1, keys: { maptiler: 'visitor-key', gamma: 'old-gamma-key' } }));
  const store = new CredentialStore({ local });
  assert.equal(store.get('maptiler'), 'visitor-key'); assert.equal(store.get('gamma'), '');
  assert.deepEqual(JSON.parse(local.getItem('datsiuk-map-credentials-v1')).keys, { maptiler: 'visitor-key', mapbox: '' });
  const onlyGamma = storage();
  onlyGamma.setItem('datsiuk-map-credentials-v1', JSON.stringify({ version: 1, keys: { gamma: 'old-gamma-key' } }));
  const empty = new CredentialStore({ local: onlyGamma });
  assert.equal(onlyGamma.data.size, 0); assert.equal(empty.remember, false);
});
