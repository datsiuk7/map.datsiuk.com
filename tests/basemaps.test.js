import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BASEMAPS, isBasemap, basemapLayer } from '../assets/basemaps.js';
import { providerForId, readState, coversPoint, providerChoices, selectLayer } from '../assets/catalog.js';
import { loadCatalog, loadSceneById, tileDefinition } from '../assets/providers.js';
import { credentials } from '../assets/credentials.js';
import { imageryKeys } from '../assets/imagery-config.js';

function fixtureKeys(t) {
  credentials.setAll({ maptiler: 'fixture-maptiler-key', mapbox: 'pk.fixture-mapbox-token' });
  t.after(() => credentials.clear());
}

test('the legacy configuration no longer ships owner credentials to visitors', () => {
  assert.ok(!Object.values(imageryKeys).some(Boolean), 'No nonempty owner keys may be bundled with the site');
});

test('the supported Esri and configured commercial mosaic sources are registered', () => {
  assert.deepEqual(Object.keys(BASEMAPS), ['esri-live', 'esri-clarity', 'maptiler', 'mapbox']);
  assert.equal(isBasemap('esri-live'), true);
  assert.equal(isBasemap('esri-clarity'), true);
  assert.equal(isBasemap('maptiler'), true);
  assert.equal(isBasemap('mapbox'), true);
  for (const source of ['esri', 'landsat', 'sentinel', 'unknown', '__proto__', 'toString', null, undefined]) {
    assert.equal(isBasemap(source), false);
    assert.equal(basemapLayer(source), null);
  }
});

test('mosaics have stable IDs and never invent acquisition dates or resolution', () => {
  for (const source of Object.keys(BASEMAPS)) {
    const layer = basemapLayer(source);
    assert.equal(layer.id, `basemap:${source}`);
    assert.equal(layer.source, source);
    assert.equal(layer.date, null);
    assert.equal(layer.dateKind, 'mosaic');
    assert.equal(layer.resolution, null);
    assert.equal(layer.nativeZoom, 19);
    assert.ok(layer.displayName && layer.shortName && layer.note);
  }
});

test('official HTTPS tile templates use ArcGIS level/row/column order without API keys', () => {
  assert.equal(basemapLayer('esri-live').template,
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');
  assert.equal(basemapLayer('esri-clarity').template,
    'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');
  for (const source of ['esri-live', 'esri-clarity']) {
    const layer = basemapLayer(source);
    const url = new URL(layer.template.replace('{z}', '17').replace('{y}', '44219').replace('{x}', '76649'));
    assert.equal(url.protocol, 'https:');
    assert.equal(url.search, '');
    assert.ok(layer.attribution.includes('Esri'));
    assert.equal(new URL(layer.attributionUrl).protocol, 'https:');
  }
});

test('MapTiler uses the live-verified TileJSON endpoint rather than inventing a tile format', () => {
  const layer = basemapLayer('maptiler');
  assert.equal(layer.metadataUrl, 'https://api.maptiler.com/tiles/satellite-v2/tiles.json?key={key}');
  assert.equal(layer.requiredKey, 'maptiler');
  assert.equal(layer.template, null);
  assert.match(layer.attribution, /MapTiler/);
  assert.equal(layer.attributionUrl, 'https://www.maptiler.com/copyright/');
});

test('Mapbox uses its documented TileJSON and JPEG raster endpoints', () => {
  const layer = basemapLayer('mapbox');
  assert.equal(layer.metadataUrl, 'https://api.mapbox.com/v4/mapbox.satellite.json?access_token={key}');
  assert.equal(layer.template, 'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg90?access_token={key}');
  assert.equal(layer.requiredKey, 'mapbox');
  assert.match(layer.attribution, /Mapbox/);
  assert.match(layer.attribution, /Maxar/);
  assert.equal(layer.feedbackUrl, 'https://apps.mapbox.com/feedback/');
});

test('credentialed providers declare public-key placeholders and visible logo assets', async () => {
  for (const source of ['maptiler', 'mapbox']) {
    const layer = basemapLayer(source);
    assert.match(layer.metadataUrl, /\{key\}/);
    assert.equal(layer.requiresLogo, true);
    assert.equal(layer.logoAlt, source === 'mapbox' ? 'Mapbox' : 'MapTiler');
    assert.equal(new URL(layer.logoHref).protocol, 'https:');
    const asset = new URL(`../${layer.logoAsset}`, import.meta.url);
    assert.match(await readFile(asset, 'utf8'), /<svg[\s>]/);
    assert.equal(layer.date, null);
    assert.equal(layer.dateKind, 'mosaic');
  }
});

test('Clarity is labelled archival and carries the official March 2028 retirement month', () => {
  const current = basemapLayer('esri-live'), clarity = basemapLayer('esri-clarity');
  assert.equal(current.label, 'Поточне покриття');
  assert.equal(current.lifecycle, 'active');
  assert.equal(current.retirementMonth, null);
  assert.equal(clarity.label, 'Архів Clarity');
  assert.equal(clarity.lifecycle, 'archived');
  assert.equal(clarity.retirementMonth, '2028-03');
  assert.match(clarity.note, /2022/);
  assert.match(clarity.note, /2028/);
  assert.match(clarity.lifecycleUrl, /esri\.com\/arcgis-blog\//);
});

test('normalizing a layer does not allow accidental mutations of the registry', () => {
  const layer = basemapLayer('esri-live');
  layer.title = 'Changed by caller';
  assert.equal(basemapLayer('esri-live').title, 'Esri World Imagery');
  assert.ok(Object.isFrozen(BASEMAPS));
  assert.ok(Object.isFrozen(BASEMAPS['esri-live']));
});

test('fresh visits start with detailed current imagery while old dated links retain their source', () => {
  const fresh = readState(new URL('https://map.test/'));
  assert.equal(fresh.leftProvider, 'esri-live');
  assert.equal(fresh.rightProvider, 'esri-live');
  const old = readState(new URL('https://map.test/?left=WB_2014_R01&right=landsat%3Aexample'));
  assert.equal(old.leftProvider, 'esri');
  assert.equal(old.rightProvider, 'landsat');
});

test('basemap IDs restore their providers from both implicit and explicit URL state', () => {
  for (const source of Object.keys(BASEMAPS)) {
    const id = `basemap:${source}`;
    assert.equal(providerForId(id), source);
    const params = new URLSearchParams({ left: id, right: 'basemap:esri-clarity' });
    const state = readState(new URL(`https://map.test/?${params}`));
    assert.equal(state.leftProvider, source);
    assert.equal(state.left, id);
    assert.equal(state.rightProvider, 'esri-clarity');
  }
  const state = readState(new URL('https://map.test/?leftProvider=maptiler&rightProvider=mapbox&mode=single'));
  assert.equal(state.leftProvider, 'maptiler');
  assert.equal(state.rightProvider, 'mapbox');
  assert.equal(state.single, true);
});

test('global basemaps cover valid map centers without needing individual scene footprints', () => {
  for (const source of Object.keys(BASEMAPS)) {
    for (const center of [{ lat: 50.45, lng: 30.52 }, { lat: -80, lng: 170 }, { lat: 80, lng: -170 }]) {
      assert.equal(coversPoint(basemapLayer(source), center), true);
    }
  }
});

test('provider filtering and all selection modes preserve undated mosaic layers', () => {
  const mosaics = Object.keys(BASEMAPS).map(basemapLayer);
  const dated = { id: 'WB_2026_R10', source: 'esri', date: '2026-10-29' };
  for (const source of Object.keys(BASEMAPS)) {
    const choices = providerChoices([...mosaics, dated], source);
    assert.equal(choices.length, 1);
    for (const mode of ['manual', 'oldest', 'newest']) {
      const selected = selectLayer(choices, { id: 'another-scene', mode, date: '1984-04-07' });
      assert.equal(selected.source, source);
      assert.equal(selected.date, null);
      assert.equal(selected.dateKind, 'mosaic');
    }
  }
  assert.deepEqual(providerChoices([...mosaics, dated], 'esri'), [dated]);
});

test('static basemap catalogs and saved IDs never make archive network requests', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; throw new Error('Unexpected network request'); });
  for (const source of Object.keys(BASEMAPS)) {
    const catalog = await loadCatalog(source, [], { lat: 50.45, lng: 30.52 }, 17, undefined, true);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].id, `basemap:${source}`);
    assert.equal(catalog[0].date, null);
    const saved = await loadSceneById(`basemap:${source}`);
    assert.equal(saved.id, catalog[0].id);
  }
  assert.equal(await loadSceneById('basemap:unknown'), null);
  assert.equal(requests, 0);
});

test('keyless Esri tile definitions are ready immediately without metadata fetches', async () => {
  let requests = 0;
  const unexpectedFetch = async () => { requests += 1; throw new Error('Unexpected metadata request'); };
  for (const source of ['esri-live', 'esri-clarity']) {
    const layer = basemapLayer(source);
    const definition = await tileDefinition(layer, undefined, unexpectedFetch, { center: { lat: 50.45, lng: 30.52 }, zoom: 17 });
    assert.equal(definition.template, layer.template);
    assert.equal(definition.nativeZoom, 19);
  }
  assert.equal(requests, 0);
});

test('MapTiler rendering derives its tile format and zoom limit from TileJSON', async t => {
  fixtureKeys(t);
  let requests = 0;
  const fetcher = async (url, options) => {
    requests += 1;
    const request = new URL(url);
    assert.equal(request.hostname, 'api.maptiler.com');
    assert.equal(request.pathname, '/tiles/satellite-v2/tiles.json');
    assert.ok(Boolean(request.searchParams.get('key')), 'A nonempty public key must be attached to the official metadata endpoint');
    assert.notEqual(options.method, 'HEAD');
    return { ok: true, status: 200, json: async () => ({
      tiles: ['https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.webp?key={key}'],
      maxzoom: 17
    }) };
  };
  const definition = await tileDefinition(basemapLayer('maptiler'), undefined, fetcher, { center: { lat: 50.45, lng: 30.52 }, zoom: 17 });
  const template = new URL(definition.template);
  assert.equal(template.hostname, 'api.maptiler.com');
  assert.equal(decodeURIComponent(template.pathname), '/tiles/satellite-v2/{z}/{x}/{y}.webp');
  assert.ok(Boolean(template.searchParams.get('key')));
  assert.equal(definition.template.includes('{key}'), false);
  assert.equal(definition.nativeZoom, 17);
  assert.equal(requests, 1);
});

test('Mapbox reports readable throttling when metadata succeeds but tile access returns 429', async t => {
  fixtureKeys(t);
  const calls = [];
  const fetcher = async (url, options) => {
    const request = new URL(url);
    calls.push({ host: request.hostname, path: request.pathname, method: options.method || 'GET' });
    assert.equal(request.hostname, 'api.mapbox.com');
    assert.ok(Boolean(request.searchParams.get('access_token')), 'Only a nonempty token presence is inspected');
    if (options.method === 'HEAD') return { ok: false, status: 429 };
    return { ok: true, status: 200, json: async () => ({
      tiles: ['https://a.tiles.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg'], maxzoom: 22
    }) };
  };
  await assert.rejects(tileDefinition(basemapLayer('mapbox'), undefined, fetcher, { center: { lat: 50.45, lng: 30.52 }, zoom: 17 }), error => {
    assert.ok(error.message.includes('Mapbox'));
    assert.ok(error.message.includes('429'));
    assert.equal(error.message.includes('access_token='), false);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/v4/mapbox.satellite.json');
  assert.equal(calls[1].method, 'HEAD');
});

test('Mapbox ignores legacy TileJSON tile hosts and probes its canonical official raster endpoint', async t => {
  fixtureKeys(t);
  let metadata = 0, probes = 0;
  const fetcher = async (url, options) => {
    const request = new URL(url);
    assert.equal(request.hostname, 'api.mapbox.com');
    assert.ok(Boolean(request.searchParams.get('access_token')));
    if (options.method === 'HEAD') {
      probes += 1;
      assert.match(request.pathname, /^\/v4\/mapbox\.satellite\/16\/\d+\/\d+\.jpg90$/);
      return { ok: true, status: 200 };
    }
    metadata += 1;
    assert.equal(request.pathname, '/v4/mapbox.satellite.json');
    return { ok: true, status: 200, json: async () => ({
      tiles: ['http://a.tiles.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.png'], maxzoom: 22
    }) };
  };
  const definition = await tileDefinition(basemapLayer('mapbox'), undefined, fetcher, { center: { lat: 50.45, lng: 30.52 }, zoom: 17 });
  const template = new URL(definition.template);
  assert.equal(template.hostname, 'api.mapbox.com');
  assert.equal(decodeURIComponent(template.pathname), '/v4/mapbox.satellite/{z}/{x}/{y}.jpg90');
  assert.ok(Boolean(template.searchParams.get('access_token')));
  assert.equal(definition.template.includes('{key}'), false);
  assert.equal(definition.nativeZoom, 19);
  assert.equal(metadata, 1);
  assert.equal(probes, 1);
});

test('a foreign tile host in TileJSON is rejected before any credentialed request reaches it', async t => {
  fixtureKeys(t);
  let requests = 0;
  const fetcher = async url => {
    requests += 1;
    const request = new URL(url);
    assert.equal(request.hostname, 'api.maptiler.com', 'No request may reach a TileJSON-supplied foreign host');
    return { ok: true, status: 200, json: async () => ({
      tiles: ['https://foreign.example.test/tiles/{z}/{x}/{y}.jpg?key={key}'], maxzoom: 20
    }) };
  };
  await assert.rejects(tileDefinition(basemapLayer('maptiler'), undefined, fetcher, { center: { lat: 50.45, lng: 30.52 }, zoom: 17 }), /підкладку/);
  assert.equal(requests, 1);
});

test('credentialed maps never use shared fallback keys when a visitor has not configured one', async () => {
  credentials.clear();
  let calls = 0;
  const unexpected = async () => { calls++; throw new Error('Unexpected request'); };
  for (const source of ['maptiler', 'mapbox']) {
    await assert.rejects(tileDefinition(basemapLayer(source), undefined, unexpected), error => error.code === 'MISSING_KEY');
  }
  assert.equal(calls, 0);
});

test('replacing a visitor key invalidates credentialed metadata instead of reusing another key', async t => {
  t.after(() => credentials.clear());
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => ({ tiles: ['https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}'], maxzoom: 19 }) };
  });
  credentials.setAll({ maptiler: 'fixture-first-visitor' });
  const first = await tileDefinition(basemapLayer('maptiler'));
  await tileDefinition(basemapLayer('maptiler'));
  assert.equal(calls, 1);
  credentials.setAll({ maptiler: 'fixture-second-visitor' });
  const second = await tileDefinition(basemapLayer('maptiler'));
  assert.equal(calls, 2);
  assert.ok(first.template.includes('fixture-first-visitor'));
  assert.ok(second.template.includes('fixture-second-visitor'));
  assert.equal(second.template.includes('fixture-first-visitor'), false);
});
