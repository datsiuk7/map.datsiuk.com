import test from 'node:test';
import assert from 'node:assert/strict';
import { providerForId, readState, coversPoint, SOURCES, providerChoices } from '../assets/catalog.js';
import { loadCatalog, loadSceneById, tileDefinition, catalogKey, openCatalog, eoxLayer, modisLayer, modisNewest, EOX_YEARS } from '../assets/providers.js';

const kyiv = { lat: 50.45, lng: 30.52 };
const now = Date.parse('2026-11-18T12:00:00Z');

test('Sentinel-2 cloudless lists yearly mosaics labelled by year', async () => {
  const layers = await loadCatalog('eox', [], kyiv, 12);
  assert.deepEqual(layers.map(layer => layer.id), EOX_YEARS.map(year => `eox:${year}`).reverse());
  assert.equal(layers[0].dateLabel, '2025 рік');
  assert.ok(coversPoint(layers[0], kyiv));
  const definition = await tileDefinition(eoxLayer(2024));
  assert.equal(definition.template, 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg');
  assert.equal(definition.nativeZoom, 14);
  assert.equal(eoxLayer(2016), null);
  assert.equal(eoxLayer('2024/../x'), null);
});

test('NASA MODIS offers one image per day from 24.02.2000', () => {
  const layers = openCatalog('modis', '2026-11-18');
  assert.equal(layers[0].date, '2026-11-18');
  assert.equal(layers.at(-1).date, '2000-02-24');
  assert.equal(new Set(layers.map(layer => layer.date)).size, layers.length);
  assert.equal(providerChoices(layers, 'modis').length, layers.length);
});

test('the MODIS list starts at the newest day with an image near the map centre', async () => {
  const empty = { ok: true, headers: new Map() };
  const image = { ok: true, headers: new Map([['layer-time-actual', 'x']]) };
  const asked = [];
  const fetcher = async url => { asked.push(url.match(/default\/([\d-]+)\//)[1]); return asked.length < 3 ? empty : image; };
  assert.equal(await modisNewest(kyiv, undefined, fetcher, now), '2026-11-16');
  assert.deepEqual(asked, ['2026-11-18', '2026-11-17', '2026-11-16']);
  const offline = async () => { throw new TypeError('offline'); };
  assert.equal(await modisNewest({ lat: -33, lng: 151 }, undefined, offline, now), '2026-11-17', 'network trouble falls back to yesterday');
});

test('MODIS tiles come from NASA GIBS for the chosen day; impossible days are refused', async () => {
  const definition = await tileDefinition(modisLayer('2026-08-10', now));
  assert.equal(definition.template, 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-08-10/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg');
  assert.equal(definition.nativeZoom, 9);
  for (const date of ['1999-12-31', '2026-02-30', '2026-11-19', '2026-8-1', '2026-08-10/../x']) assert.equal(modisLayer(date, now), null, date);
});

test('shared links restore open imagery without a catalogue request', async () => {
  assert.equal(providerForId('eox:2024'), 'eox');
  assert.equal(providerForId('modis:2026-08-10'), 'modis');
  assert.equal(readState(new URL('https://map.test/?left=eox%3A2019&right=modis%3A2026-08-10')).rightProvider, 'modis');
  assert.ok(SOURCES.eox && SOURCES.modis);
  const fetcher = async () => { throw new Error('no request expected'); };
  assert.equal((await loadSceneById('eox:2019', undefined, fetcher)).id, 'eox:2019');
  assert.equal((await loadSceneById('modis:2020-05-01', undefined, fetcher)).date, '2020-05-01');
  assert.equal(await loadSceneById('eox:1999', undefined, fetcher), null);
  assert.equal(catalogKey('eox', kyiv, 12), catalogKey('eox', { lat: -33, lng: 151 }, 5), 'one list for the whole world');
  assert.notEqual(catalogKey('modis', kyiv, 12), catalogKey('modis', { lat: -33, lng: 151 }, 5), 'the newest day is checked per region');
});
