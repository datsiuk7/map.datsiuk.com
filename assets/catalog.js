import { BASEMAPS, isBasemap } from './basemaps.js';

export const SOURCES = {
  ...Object.fromEntries(Object.entries(BASEMAPS).map(([id, layer]) => [id, { name: layer.shortName, priority: 0, kind: 'basemap' }])),
  esri: { name: 'Esri', priority: 0 },
  sentinel: { name: 'Sentinel-2', priority: 1 },
  eox: { name: 'Sentinel-2 cloudless', priority: 2 },
  landsat: { name: 'Landsat', priority: 3 },
  modis: { name: 'NASA MODIS', priority: 4 }
};

export function boundedNumber(value, fallback, min, max) {
  if (value === null || value === '' || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function providerForId(id) {
  if (id?.startsWith('basemap:') && isBasemap(id.slice(8))) return id.slice(8);
  const source = id?.split(':')[0];
  return ['landsat', 'sentinel', 'eox', 'modis'].includes(source) ? source : 'esri';
}

export function readState(url) {
  const params = url.searchParams;
  const parts = url.hash.replace(/^#/, '').split('/');
  const validView = parts.length === 3 && parts.every(part => part !== '' && Number.isFinite(Number(part)));
  const provider = side => {
    const requested = params.get(`${side}Provider`);
    if (Object.hasOwn(SOURCES, requested)) return requested;
    if (params.get(side)) return providerForId(params.get(side));
    return params.has(`${side}Provider`) ? 'esri' : 'esri-live';
  };
  return {
    left: params.get('left'),
    right: params.get('right'),
    leftProvider: provider('left'),
    rightProvider: provider('right'),
    single: params.get('mode') === 'single',
    center: validView ? [boundedNumber(parts[1], 50.4501, -85, 85), ((Number(parts[2]) + 180) % 360 + 360) % 360 - 180] : [50.4501, 30.5234],
    zoom: validView ? boundedNumber(parts[0], 12, 2, 18) : 12,
    split: boundedNumber(params.get('split'), 0.5, 0.12, 0.88),
    visualZoom: boundedNumber(params.get('visualZoom'), 100, 100, 1000),
    magnify: params.get('magnify') === '1' || (!params.has('magnify') && Number(params.get('visualZoom')) > 100),
    labels: params.get('labels') === '1',
    separate: params.get('mode') === 'separate' || (params.get('mode') === 'single' && params.get('comparison') === 'separate'),
    hideSlider: params.get('slider') === '0' || params.get('hideSlider') === '1',
    collapsed: params.get('panel') === '0'
  };
}

export function compareLayers(a, b) {
  return (b.date || '').localeCompare(a.date || '')
    || SOURCES[a.source].priority - SOURCES[b.source].priority
    || (a.cloud ?? 100) - (b.cloud ?? 100)
    || a.id.localeCompare(b.id);
}

// One choice per day. Preserve an explicitly shared/selected scene for that day.
export function dateChoices(layers, preferredId) {
  const dates = new Map();
  for (const layer of [...layers].sort(compareLayers)) {
    if (!dates.has(layer.date) || layer.id === preferredId) dates.set(layer.date, layer);
  }
  return [...dates.values()].sort(compareLayers);
}

export function providerChoices(layers, provider, preferredId) {
  if (isBasemap(provider)) return layers.filter(layer => layer.source === provider).slice(0, 1);
  return dateChoices(layers.filter(layer => layer.source === provider), preferredId);
}

export function filterDates(choices, year = 'all', month = 'all') {
  return choices.filter(layer => (year === 'all' || layer.date.startsWith(`${year}-`))
    && (month === 'all' || layer.date.slice(5, 7) === month));
}

// Chronological arrows work over the provider's complete timeline, across year filters.
export function adjacentLayer(choices, id, direction) {
  const index = choices.findIndex(layer => layer.id === id);
  if (index < 0) return null;
  return choices[index + (direction === 'older' ? 1 : -1)] || null;
}

export function layoutSizes(width, split, separate, single) {
  const left = single ? width : Math.round(width * (separate ? 0.5 : split));
  return { left, right: single ? 0 : width - left, separate: separate && !single };
}

export function selectLayer(choices, { id, mode, date }) {
  if (!choices.length) return null;
  if (isBasemap(choices[0].source)) return choices[0];
  if (mode === 'oldest') return choices.at(-1);
  if (mode === 'newest') return choices[0];
  const exact = choices.find(layer => layer.id === id);
  if (exact) return exact;
  if (!date) return choices[0];
  const time = Date.parse(date);
  return choices.reduce((best, layer) => Math.abs(Date.parse(layer.date) - time) < Math.abs(Date.parse(best.date) - time) ? layer : best);
}

function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function coversPoint(layer, center) {
  if (layer.source === 'esri' || isBasemap(layer.source)) return true;
  const point = [center.lng, center.lat];
  const geometry = layer.geometry;
  if (geometry) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    return polygons.some(rings => inRing(point, rings[0]) && !rings.slice(1).some(ring => inRing(point, ring)));
  }
  const b = layer.bounds;
  return Boolean(b && point[0] >= b[0] && point[0] <= b[2] && point[1] >= b[1] && point[1] <= b[3]);
}

// Invalidates the previous request even when the next location comes from cache.
export class LatestRequest {
  begin(key) {
    this.controller?.abort();
    this.controller = new AbortController();
    const request = { key, signal: this.controller.signal };
    this.current = request;
    return request;
  }
  isCurrent(request) { return this.current === request && !request.signal.aborted; }
  cancel() { this.controller?.abort(); }
}

export function tileCoordinates(center, zoom) {
  const level = Math.max(2, Math.min(18, Math.round(zoom)));
  const scale = 2 ** level;
  const latitude = Math.max(-85.05112877, Math.min(85.05112877, center.lat));
  const lng = ((center.lng + 180) % 360 + 360) % 360 - 180;
  return {
    level,
    column: Math.min(scale - 1, Math.floor((lng + 180) / 360 * scale)),
    row: Math.min(scale - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * scale)))
  };
}

// Query the complete small cell so cached results remain correct after nearby pans.
export function sceneArea(center) {
  const { level, row, column } = tileCoordinates(center, 12);
  const scale = 2 ** level;
  const latitude = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI;
  return {
    key: `${level}/${row}/${column}`,
    bounds: [column / scale * 360 - 180, latitude(row + 1), (column + 1) / scale * 360 - 180, latitude(row)]
  };
}
