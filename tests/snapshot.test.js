import test from 'node:test';
import assert from 'node:assert/strict';
import { project, unproject, visibleRegion, planCapture, tilesFor, tileUrl, tileInBounds, parentSource, readTilemap, captureZoomLimit, MAX_PIXELS } from '../assets/snapshot.js';
import { entriesToPrune, createSnapshotStore } from '../assets/snapshot-store.js';
import { enhanceLimit } from '../assets/enhance.js';
import { describePhoto } from '../assets/photos-ui.js';

const kyiv = { lat: 50.4501, lng: 30.5234 };

test('projection matches the tile grid used by the providers', () => {
  const point = project(kyiv.lat, kyiv.lng, 18);
  assert.equal(Math.floor(point.x / 256), 153298);
  assert.equal(Math.floor(point.y / 256), 88392);
  const back = unproject(point.x, point.y, 18);
  assert.ok(Math.abs(back.lat - kyiv.lat) < 1e-9 && Math.abs(back.lng - kyiv.lng) < 1e-9);
});

test('a magnified view captures only the smaller area the user sees', () => {
  const full = visibleRegion({ center: kyiv, zoom: 18, width: 1600, height: 900 });
  const magnified = visibleRegion({ center: kyiv, zoom: 18, width: 1600, height: 900, magnification: 4 });
  assert.equal(full.right - full.left, 1600);
  assert.equal(magnified.right - magnified.left, 400);
  assert.equal(magnified.bottom - magnified.top, 225);
  assert.equal((magnified.left + magnified.right) / 2, (full.left + full.right) / 2);
});

test('the photo uses the deepest level that still fits the canvas limit', () => {
  const region = visibleRegion({ center: kyiv, zoom: 18, width: 1600, height: 900, magnification: 4 });
  const plan = planCapture(region, { maxZoom: 19 });
  assert.equal(plan.zoom, 19);
  assert.ok(Math.abs(plan.width - 800) <= 1 && Math.abs(plan.height - 450) <= 1);
  const wide = visibleRegion({ center: kyiv, zoom: 14, width: 1920, height: 1080 });
  const limited = planCapture(wide, { maxZoom: 19 });
  assert.ok(limited.zoom < 19 && limited.zoom >= 14);
  assert.ok(limited.width * limited.height <= MAX_PIXELS);
});

test('tiles cover the requested pixels and wrap across the antimeridian', () => {
  const tiles = tilesFor(2, -100, 300, 300, 200);
  assert.deepEqual([...new Set(tiles.map(tile => tile.x))].sort(), [0, 3]);
  assert.ok(tiles.every(tile => tile.y >= 1 && tile.y <= 1));
  assert.equal(tiles[0].drawX, -156);
  assert.equal(tileUrl('https://t/{z}/{y}/{x}.jpg?k=1', { x: 3, y: 1, z: 2 }), 'https://t/2/1/3.jpg?k=1');
});

test('missing tiles are replaced by the matching quarter of their parent', () => {
  assert.deepEqual(parentSource({ x: 613193, y: 353569, z: 20 }, 1), { x: 306596, y: 176784, z: 19, sx: 128, sy: 128, size: 128 });
  assert.deepEqual(parentSource({ x: 4, y: 7, z: 5 }, 2), { x: 1, y: 1, z: 3, sx: 0, sy: 192, size: 64 });
});

test('Esri tilemap answers are read relative to their reported location', () => {
  const data = { location: { left: 10, top: 20, width: 2, height: 2 }, data: [1, 0, 0, 1] };
  const known = readTilemap(data, [{ x: 10, y: 20 }, { x: 11, y: 20 }, { x: 11, y: 21 }, { x: 40, y: 40 }]);
  assert.equal(known.get('10/20'), true);
  assert.equal(known.get('11/20'), false);
  assert.equal(known.get('11/21'), true);
  assert.equal(known.has('40/40'), false);
  assert.equal(readTilemap({ valid: false }, [{ x: 1, y: 1 }]).size, 0);
});

test('scene footprints exclude tiles outside the Landsat frame', () => {
  const bounds = [[50, 30], [51, 31]];
  const inside = { ...project(50.5, 30.5, 12) };
  const tile = { x: Math.floor(inside.x / 256), y: Math.floor(inside.y / 256), z: 12 };
  assert.equal(tileInBounds(tile, bounds), true);
  assert.equal(tileInBounds({ ...tile, x: tile.x + 50 }, bounds), false);
  assert.equal(tileInBounds(tile, null), true);
});

test('capture levels follow what each provider really serves', () => {
  assert.equal(captureZoomLimit('esri', 18), 19);
  assert.equal(captureZoomLimit('esri-live', 19), 21);
  assert.equal(captureZoomLimit('landsat', 12), 12);
  assert.equal(captureZoomLimit('mapbox', 19), 19);
});

test('history keeps the newest photos within count and size limits', () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, createdAt: index, bytes: 10 }));
  assert.deepEqual(entriesToPrune(entries, { maxEntries: 3, maxBytes: 1000 }).sort(), ['p0', 'p1']);
  assert.deepEqual(entriesToPrune(entries, { maxEntries: 10, maxBytes: 25 }).sort(), ['p0', 'p1', 'p2']);
  assert.deepEqual(entriesToPrune([{ id: 'huge', createdAt: 1, bytes: 999 }], { maxEntries: 3, maxBytes: 10 }), []);
});

test('history works in memory when IndexedDB is unavailable', async () => {
  const store = createSnapshotStore({ indexedDB: undefined, limits: { maxEntries: 2, maxBytes: 1e9 } });
  for (const id of ['a', 'b', 'c']) await store.save({ id, createdAt: id.charCodeAt(0), blob: { size: 5 } });
  assert.deepEqual((await store.list()).map(entry => entry.id), ['c', 'b']);
  assert.equal((await store.get('b')).bytes, 5);
  await store.remove('b');
  assert.deepEqual((await store.list()).map(entry => entry.id), ['c']);
  await store.clear();
  assert.equal((await store.list()).length, 0);
});

test('AI upscaling is refused for photos that would exceed the output budget', () => {
  assert.equal(enhanceLimit(800, 450, 4), true);
  assert.equal(enhanceLimit(3200, 1800, 2), false);
});

test('photo descriptions state real detail and mark AI output', () => {
  assert.equal(describePhoto({ width: 800, height: 466, captureZoom: 19, gain: 2, metersPerPixel: 0.19, tiles: { fallback: 0 } }), '800×466 · рівень 19 · ×2 до екрана · крок тайлів ≈ 0,19 м');
  assert.equal(describePhoto({ kind: 'ai', scale: 4, width: 3200, height: 1864 }), '3200×1864 · ШІ ×4 · деталі домальовано');
});

test('a release without deep tiles is captured at its real level, not upscaled', async () => {
  const requested = [];
  globalThis.createImageBitmap = async () => ({ close() {} });
  const fetcher = async url => {
    requested.push(url);
    const zoom = Number(url.split('/')[3]);
    return zoom > 18 ? { ok: false, status: 404 } : { ok: true, blob: async () => ({ type: 'image/jpeg', size: 9000 }) };
  };
  const drawn = [];
  globalThis.document = { createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ fillRect() {}, drawImage: (...args) => drawn.push(args), fillText() {}, set fillStyle(v) {}, set font(v) {}, set textBaseline(v) {}, set textAlign(v) {}, set imageSmoothingQuality(v) {} }),
    toBlob: callback => callback({ size: 1 })
  }) };
  try {
    const { capturePhoto } = await import('../assets/snapshot.js');
    const photo = await capturePhoto({
      template: 'https://wb/{z}/{y}/{x}', source: 'esri', nativeZoom: 18, displayZoom: 18,
      center: kyiv, zoom: 17, width: 800, height: 600, magnification: 1, credits: 'Esri'
    }, { fetcher });
    assert.equal(photo.captureZoom, 18);
    assert.equal(photo.gain, 2);
    assert.equal(photo.tiles.fallback, 0);
    assert.equal(requested.filter(url => url.includes('/19/')).length, 1);
  } finally {
    delete globalThis.document;
    delete globalThis.createImageBitmap;
  }
});
