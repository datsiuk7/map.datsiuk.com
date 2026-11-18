import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../assets/connection-checks.js';

test('Gamma key checking only reads credits and never submits a chargeable processing job', async () => {
  const calls = [];
  const result = await checkConnection('gamma', 'fixture-gamma-key', { fetcher: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ credits: { total_balance: 75 }, jobs: [] }) };
  } });
  assert.equal(result.balance, 75);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].url, 'https://api.gamma.earth/jobs/fixture-gamma-key?limit=1');
});

test('a valid Gamma account with zero credits remains a valid connection', async () => {
  const result = await checkConnection('gamma', 'fixture-gamma-key', { fetcher: async () => ({ ok: true, json: async () => ({ credits: { total_balance: 0 } }) }) });
  assert.equal(result.balance, 0);
  await assert.rejects(checkConnection('gamma', 'fixture-gamma-key', { fetcher: async () => ({ ok: true, json: async () => ({ jobs: [] }) }) }), /не повернув баланс/);
});

test('Mapbox metadata success does not conceal a 429 imagery failure', async () => {
  let calls = 0;
  await assert.rejects(checkConnection('mapbox', 'pk.fixture-token', { fetcher: async (url, options) => {
    calls++;
    assert.equal(new URL(url).hostname, 'api.mapbox.com');
    return options.method === 'HEAD' ? { ok: false, status: 429 } : { ok: true };
  } }), /429/);
  assert.equal(calls, 2);
});

test('MapTiler checks the visitors imagery without following a foreign TileJSON host', async () => {
  const urls = [];
  const fetcher = async (url, options) => {
    urls.push(url);
    if (options.method === 'HEAD') return { ok: true };
    return { ok: true, json: async () => ({ tiles: ['https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}'] }) };
  };
  await checkConnection('maptiler', 'fixture-user-key', { fetcher });
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => new URL(url).searchParams.get('key') === 'fixture-user-key'));
  let calls = 0;
  await assert.rejects(checkConnection('maptiler', 'fixture-user-key', { fetcher: async () => {
    calls++;
    return { ok: true, json: async () => ({ tiles: ['https://foreign.test/{z}/{x}/{y}?key={key}'] }) };
  } }), /непідтримувану/);
  assert.equal(calls, 1);
});

test('an unsupported HEAD can use one real tile, while unauthorized access never retries', async () => {
  const methods = [];
  await checkConnection('mapbox', 'pk.fixture-token', { fetcher: async (_url, options) => {
    methods.push(options.method);
    return options.method === 'HEAD' ? { ok: false, status: 405 } : { ok: true };
  } });
  assert.deepEqual(methods, ['GET', 'HEAD', 'GET']);
  let calls = 0;
  await assert.rejects(checkConnection('gamma', 'fixture-gamma-key', { fetcher: async () => { calls++; return { ok: false, status: 401 }; } }), /401/);
  assert.equal(calls, 1);
});

test('empty or private keys are rejected before a network request and cancelled checks do not connect', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('Unexpected request'); };
  await assert.rejects(checkConnection('gamma', '', { fetcher }), /власний ключ/);
  await assert.rejects(checkConnection('mapbox', 'sk.private-token', { fetcher }), /публічний токен/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(checkConnection('gamma', 'fixture-key', { fetcher, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('timeouts and network failures have readable messages without disclosing request URLs', async () => {
  await assert.rejects(checkConnection('gamma', 'fixture-gamma-key', { timeoutMs: 5, fetcher: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) }), /вчасно/);
  await assert.rejects(checkConnection('gamma', 'fixture-gamma-key', { fetcher: async () => { throw new TypeError('https://api.gamma.earth/jobs/fixture-gamma-key'); } }), error => !error.message.includes('fixture-gamma-key') && error.message.includes('з’єднатися'));
});
