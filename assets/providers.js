import { compareLayers, tileCoordinates, sceneArea } from './catalog.js';
import { ResourceCache, persistentStore, purgeLegacyCredentialMetadata } from './performance.js';
import { isBasemap, basemapLayer } from './basemaps.js';
import { credentials } from './credentials.js';

export const PC = 'https://planetarycomputer.microsoft.com';
const WAYBACK = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer';
const COLLECTIONS = { landsat: 'landsat-c2-l2' };
const catalogCache = new ResourceCache({ maxEntries: 16, ttl: 1200000, storage: persistentStore('catalogs', 16) });
const metadataCache = new ResourceCache({ maxEntries: 128, ttl: 86400000, storage: persistentStore('metadata', 128) });
// URLs containing visitor keys stay in memory, never in IndexedDB.
const credentialMetadataCache = new ResourceCache({ maxEntries: 8, ttl: 3600000 });
purgeLegacyCredentialMetadata().catch(() => {});
credentials.subscribe(changed => {
  for (const key of new Set([...credentialMetadataCache.entries.keys(), ...credentialMetadataCache.jobs.keys()])) {
    if (changed.some(source => key.startsWith(`basemap:${source}:`))) credentialMetadataCache.delete(key);
  }
});

export async function fetchJson(url, signal, fetcher = fetch, timeoutMs = 20000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`Сервіс повернув HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (timedOut) throw new Error('Сервіс не відповів вчасно');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function parseWayback(config) {
  return Object.entries(config).flatMap(([release, item]) => {
    const date = item.itemTitle?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!date || !item.layerIdentifier || !item.itemURL || !Number.isFinite(Number(release))) return [];
    return [{
      id: item.layerIdentifier, date, source: 'esri', releaseNum: Number(release),
      template: item.itemURL.replace('{level}', '{z}').replace('{row}', '{y}').replace('{col}', '{x}'),
      dateKind: 'publication', resolution: null
    }];
  }).sort(compareLayers);
}

export async function loadWayback(signal) {
  return catalogCache.get('wayback-config', async requestSignal => {
    const data = await fetchJson('https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json', requestSignal);
    const layers = parseWayback(data);
    if (!layers.length) throw new Error('Каталог Esri порожній');
    return layers;
  }, { signal });
}

export function catalogKey(source, center, zoom, wayback = []) {
  if (isBasemap(source)) return `basemap:${source}`;
  if (source !== 'esri') return `${source}:${sceneArea(center).key}`;
  const tile = tileCoordinates(center, zoom);
  return `esri:${wayback[0]?.id}:${wayback.length}:${tile.level}/${tile.row}/${tile.column}`;
}

export function loadCatalog(source, wayback, center, zoom, signal, force = false) {
  if (isBasemap(source)) return Promise.resolve([basemapLayer(source)]);
  if (source !== 'esri' && !Object.hasOwn(COLLECTIONS, source)) return Promise.resolve([]);
  return catalogCache.get(catalogKey(source, center, zoom, wayback), requestSignal => source === 'esri'
    ? localWayback(wayback, center, zoom, requestSignal)
    : loadScenes(source, center, requestSignal), { signal, force });
}

export async function localWayback(layers, center, zoom, signal, fetcher = fetch) {
  const { level, row, column } = tileCoordinates(center, zoom);
  const byRelease = new Map(layers.map((layer, index) => [layer.releaseNum, { layer, index }]));
  const visited = new Set();
  const result = [];
  let release = layers[0]?.releaseNum;
  while (release && !visited.has(release)) {
    visited.add(release);
    const data = await fetchJson(`${WAYBACK}/tilemap/${release}/${level}/${row}/${column}`, signal, fetcher, 10000);
    if (!data.data?.[0]) break;
    const changed = Number(data.select?.[0]) || release;
    const match = byRelease.get(changed);
    if (!match) break;
    if (!result.some(layer => layer.id === match.layer.id)) result.push(match.layer);
    release = layers[match.index + 1]?.releaseNum;
  }
  return result;
}

export function sceneLayer(item) {
  const source = Object.keys(COLLECTIONS).find(key => COLLECTIONS[key] === item.collection);
  const date = item.properties?.datetime?.slice(0, 10);
  if (!source || !date || !item.id || !item.assets?.tilejson?.href) return null;
  const tilejson = new URL(item.assets.tilejson.href);
  if (tilejson.origin !== PC || !tilejson.pathname.startsWith('/api/data/v1/item/')) return null;
  return {
    id: `${source}:${item.id}`, itemId: item.id, source, date, dateKind: 'acquisition',
    collection: item.collection, cloud: item.properties['eo:cloud_cover'],
    resolution: 30,
    bounds: item.bbox, geometry: item.geometry, tilejson: tilejson.href
  };
}

export async function loadScenes(source, center, signal, fetcher = fetch) {
  if (!Object.hasOwn(COLLECTIONS, source)) return [];
  const params = new URLSearchParams({
    collections: COLLECTIONS[source],
    bbox: sceneArea(center).bounds.join(','),
    limit: '1000', sortby: '-datetime',
    query: JSON.stringify({ 'eo:cloud_cover': { lte: 30 } }),
    fields: 'id,collection,bbox,geometry,properties.datetime,properties.eo:cloud_cover,assets.tilejson'
  });
  let url = `${PC}/api/stac/v1/search?${params}`;
  const scenes = new Map();
  const visited = new Set();
  while (url) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (visited.has(url) || visited.size >= 20) throw new Error('Каталог повернув неповний список дат');
    visited.add(url);
    const data = await fetchJson(url, signal, fetcher);
    if (!Array.isArray(data.features)) throw new Error('Некоректна відповідь каталогу');
    for (const item of data.features) {
      const layer = sceneLayer(item);
      if (layer) scenes.set(layer.id, layer);
    }
    const next = data.links?.find(link => link.rel === 'next');
    if (next && (new URL(next.href).origin !== PC || (next.method && next.method !== 'GET'))) throw new Error('Непідтримувана сторінка каталогу');
    url = next?.href;
  }
  return [...scenes.values()].sort(compareLayers);
}

export async function loadSceneById(id, signal, fetcher = fetch) {
  if (id.startsWith('basemap:')) return basemapLayer(id.slice(8));
  const separator = id.indexOf(':');
  const source = id.slice(0, separator), itemId = id.slice(separator + 1);
  if (!COLLECTIONS[source] || !/^[A-Za-z0-9_.-]+$/.test(itemId)) return null;
  const load = requestSignal => fetchJson(`${PC}/api/stac/v1/collections/${COLLECTIONS[source]}/items/${encodeURIComponent(itemId)}`, requestSignal, fetcher).then(sceneLayer);
  return fetcher === fetch ? metadataCache.get(`scene:${id}`, load, { signal }) : load(signal);
}

export async function probeBasemap(layer, template, viewpoint, signal, fetcher = fetch) {
  if (layer.source !== 'mapbox' || !viewpoint) return;
  const tile = tileCoordinates(viewpoint.center, Math.min(viewpoint.zoom, 16));
  const url = template.replace('{z}', tile.level).replace('{y}', tile.row).replace('{x}', tile.column);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 8000);
  let response;
  try {
    response = await fetcher(url, { method: 'HEAD', signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return; // Some proxies do not support HEAD; normal image loading can still work.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  if ([401, 402, 403, 429].includes(response.status)) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
}

export async function tileDefinition(layer, signal, fetcher = fetch, viewpoint) {
  if (isBasemap(layer.source)) {
    if (!layer.requiredKey) return { template: layer.template, nativeZoom: layer.nativeZoom };
    const key = credentials.get(layer.requiredKey);
    if (!key) {
      const error = new Error(`Додайте власний ключ ${layer.shortName} у «API-ключі».`);
      error.code = 'MISSING_KEY';
      throw error;
    }
    const loadBasemap = async requestSignal => {
      const url = layer.metadataUrl.replace('{key}', encodeURIComponent(key));
      const data = await fetchJson(url, requestSignal, fetcher);
      const template = (layer.template || data.tiles?.[0])?.replace('{key}', encodeURIComponent(key)).replace(/^http:/, 'https:');
      const expectedHost = layer.source === 'mapbox' ? 'api.mapbox.com' : 'api.maptiler.com';
      if (!template || new URL(template).hostname !== expectedHost) throw new Error('Провайдер не надав підтримувану супутникову підкладку.');
      return { template, nativeZoom: Math.min(data.maxzoom ?? layer.nativeZoom, layer.nativeZoom) };
    };
    try {
      const definition = fetcher === fetch
        ? await credentialMetadataCache.get(`basemap:${layer.source}:${credentials.revision(layer.source)}`, loadBasemap, { signal })
        : await loadBasemap(signal);
      // Availability can change while the metadata remains cached.
      await probeBasemap(layer, definition.template, viewpoint, signal, fetcher);
      return definition;
    } catch (error) {
      if (error.status === 429) throw new Error(`${layer.shortName} тимчасово обмежив запити (429). Повторіть пізніше.`);
      if ([401, 402, 403].includes(error.status)) throw new Error(`${layer.shortName} не надав доступ (HTTP ${error.status}). Перевірте доступність сервісу для цього ключа.`);
      throw error;
    }
  }
  if (layer.source === 'esri') return { template: layer.template, nativeZoom: 18 };
  const load = async requestSignal => {
    const data = await fetchJson(layer.tilejson, requestSignal, fetcher);
    const template = data.tiles?.[0];
    if (!template || new URL(template).origin !== PC) throw new Error('Сервіс не надав зображення');
    return { template, nativeZoom: 12, bounds: layer.bounds || data.bounds };
  };
  return fetcher === fetch ? metadataCache.get(`tiles:${layer.id}`, load, { signal }) : load(signal);
}
