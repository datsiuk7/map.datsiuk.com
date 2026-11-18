// High-resolution photos of the visible map area.
// The screen shows tiles at the map zoom (max 18) and the "Наближення" slider only
// stretches them. Here the same area is rebuilt from the deepest tiles the provider
// really serves, so the photo contains more source pixels than the screen shows.

export const TILE_SIZE = 256;
// Safari and mobile browsers refuse canvases larger than ~16.7 MP.
export const MAX_PIXELS = 16_000_000;
export const MAX_SIDE = 8192;
const MAX_LATITUDE = 85.0511287798;
const ESRI_LIVE_TILES = /^https:\/\/services\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/;

// Deepest zoom a provider may have. Missing tiles fall back to their parents.
export function captureZoomLimit(source, nativeZoom) {
  if (source === 'esri-live') return 21; // Esri tilemap tells where z20+ exists.
  if (source === 'esri' || source === 'esri-clarity') return 19; // Wayback releases expose z19.
  return nativeZoom;
}

export function project(lat, lng, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const latitude = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * Math.PI / 180;
  return {
    x: (lng + 180) / 360 * scale,
    y: (1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * scale
  };
}

export function unproject(x, y, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  return {
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI,
    lng: x / scale * 360 - 180
  };
}

// Area the user actually sees: the CSS magnifier scales around the map centre.
export function visibleRegion({ center, zoom, width, height, magnification = 1 }) {
  const point = project(center.lat, center.lng, zoom);
  const halfWidth = width / magnification / 2, halfHeight = height / magnification / 2;
  return { zoom, left: point.x - halfWidth, top: point.y - halfHeight, right: point.x + halfWidth, bottom: point.y + halfHeight };
}

export function scaleRegion(region, zoom) {
  const factor = 2 ** (zoom - region.zoom);
  return { zoom, left: region.left * factor, top: region.top * factor, right: region.right * factor, bottom: region.bottom * factor };
}

// Highest zoom whose photo still fits the canvas limits.
export function planCapture(region, { maxZoom, minZoom = 0, maxPixels = MAX_PIXELS, maxSide = MAX_SIDE }) {
  for (let zoom = Math.floor(maxZoom); zoom >= minZoom; zoom -= 1) {
    const area = scaleRegion(region, zoom);
    const left = Math.floor(area.left), top = Math.floor(area.top);
    const width = Math.ceil(area.right) - left, height = Math.ceil(area.bottom) - top;
    if (width < 1 || height < 1) continue;
    if (width * height <= maxPixels && width <= maxSide && height <= maxSide) {
      return { zoom, left, top, width, height, tiles: tilesFor(zoom, left, top, width, height) };
    }
  }
  return null;
}

export function tilesFor(zoom, left, top, width, height) {
  const count = 2 ** zoom, tiles = [];
  const firstX = Math.floor(left / TILE_SIZE), lastX = Math.floor((left + width - 1) / TILE_SIZE);
  const firstY = Math.max(0, Math.floor(top / TILE_SIZE)), lastY = Math.min(count - 1, Math.floor((top + height - 1) / TILE_SIZE));
  for (let y = firstY; y <= lastY; y += 1) {
    for (let x = firstX; x <= lastX; x += 1) {
      tiles.push({ x: ((x % count) + count) % count, y, z: zoom, drawX: x * TILE_SIZE - left, drawY: y * TILE_SIZE - top });
    }
  }
  return tiles;
}

export function tileUrl(template, { x, y, z }) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{-y}', 2 ** z - 1 - y).replace('{s}', 'a').replace('{r}', '');
}

// Tiles outside a scene footprint are left as neutral background, as on the map.
export function tileInBounds({ x, y, z }, bounds) {
  if (!bounds) return true;
  const [[south, west], [north, east]] = bounds;
  const northWest = unproject(x * TILE_SIZE, y * TILE_SIZE, z);
  const southEast = unproject((x + 1) * TILE_SIZE, (y + 1) * TILE_SIZE, z);
  return northWest.lng < east && southEast.lng > west && southEast.lat < north && northWest.lat > south;
}

// Parent tile and the sub-square that covers a missing child tile.
export function parentSource(tile, levelsUp) {
  const divisions = 2 ** levelsUp, size = TILE_SIZE / divisions;
  return {
    x: Math.floor(tile.x / divisions), y: Math.floor(tile.y / divisions), z: tile.z - levelsUp,
    sx: (tile.x % divisions) * size, sy: (tile.y % divisions) * size, size
  };
}

export function readTilemap(data, tiles) {
  const location = data?.location;
  if (!Array.isArray(data?.data) || !location) return new Map();
  const result = new Map();
  for (const tile of tiles) {
    const column = tile.x - location.left, row = tile.y - location.top;
    if (column < 0 || row < 0 || column >= location.width || row >= location.height) continue;
    result.set(`${tile.x}/${tile.y}`, data.data[row * location.width + column] === 1);
  }
  return result;
}

async function esriAvailability(tiles, zoom, signal, fetcher) {
  const xs = tiles.map(tile => tile.x), ys = tiles.map(tile => tile.y);
  const left = Math.min(...xs), top = Math.min(...ys);
  const width = Math.max(...xs) - left + 1, height = Math.max(...ys) - top + 1;
  const known = new Map();
  for (let row = top; row < top + height; row += 32) {
    for (let column = left; column < left + width; column += 32) {
      const url = `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tilemap/${zoom}/${row}/${column}/${Math.min(32, top + height - row)}/${Math.min(32, left + width - column)}`;
      const response = await fetcher(url, { signal });
      if (!response.ok) throw new Error(`tilemap HTTP ${response.status}`);
      for (const [key, value] of readTilemap(await response.json(), tiles)) known.set(key, value);
    }
  }
  return known;
}

// Esri World Imagery answers missing deep tiles with a "no data" picture,
// so its tilemap decides which level actually has imagery here.
async function chooseEsriPlan(region, limits, signal, fetcher) {
  for (let zoom = limits.maxZoom; zoom > limits.nativeZoom; zoom -= 1) {
    const plan = planCapture(region, { ...limits, maxZoom: zoom });
    if (!plan || plan.zoom !== zoom || plan.tiles.length > 1200) continue;
    try {
      const available = await esriAvailability(plan.tiles, zoom, signal, fetcher);
      const present = plan.tiles.filter(tile => available.get(`${tile.x}/${tile.y}`)).length;
      if (present / plan.tiles.length >= 0.9) return { ...plan, available };
    } catch (error) {
      if (signal?.aborted) throw error;
      break;
    }
  }
  const plan = planCapture(region, { ...limits, maxZoom: Math.min(limits.maxZoom, limits.nativeZoom) });
  if (!plan) return null;
  try { return { ...plan, available: await esriAvailability(plan.tiles, plan.zoom, signal, fetcher) }; }
  catch (error) { if (signal?.aborted) throw error; return plan; }
}

// Other providers answer missing deep tiles with errors: test the centre tile
// and step down until a level really exists, instead of upscaling parents.
async function chooseProbedPlan(view, region, limits, signal, fetcher) {
  let plan = planCapture(region, limits);
  for (let attempt = 0; plan && plan.zoom > Math.min(view.displayZoom, view.zoom) && attempt < 3; attempt += 1) {
    const centre = project(view.center.lat, view.center.lng, plan.zoom);
    const count = 2 ** plan.zoom;
    const tile = { x: ((Math.floor(centre.x / TILE_SIZE) % count) + count) % count, y: Math.floor(centre.y / TILE_SIZE), z: plan.zoom };
    try {
      const bitmap = await loadBitmap(tileUrl(view.template, tile), signal, fetcher);
      bitmap.close?.();
      return plan;
    } catch (error) {
      if (signal?.aborted) throw error;
      plan = planCapture(region, { ...limits, maxZoom: plan.zoom - 1 });
    }
  }
  return plan;
}

async function loadBitmap(url, signal, fetcher) {
  const response = await fetcher(url, { signal, mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/') && blob.size < 400) throw new Error('not an image');
  return createImageBitmap(blob);
}

async function pool(items, limit, worker) {
  let index = 0;
  const run = async () => { while (index < items.length) { const item = items[index++]; await worker(item); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Браузер не зміг створити зображення')), type, quality));
}

export async function thumbnail(source, width = 360) {
  const ratio = width / source.width;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(source.height * ratio));
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, 'image/jpeg', 0.8);
}

export function creditHeight(width) {
  return Math.max(16, Math.min(34, Math.round(width / 80)));
}

export function drawCredits(context, width, top, height, text) {
  context.fillStyle = '#f4f7f8';
  context.fillRect(0, top, width, height);
  context.fillStyle = '#33464f';
  const size = Math.round(height * 0.55);
  context.font = `${size}px Arial, Helvetica, sans-serif`;
  context.textBaseline = 'middle';
  context.textAlign = 'right';
  context.fillText(text, width - size * 0.6, top + height / 2, width - size * 1.2);
}

/**
 * Builds the photo. `view` describes what is on screen:
 * { template, source, nativeZoom, displayZoom, bounds, center, zoom, width, height, magnification, credits }
 */
export async function capturePhoto(view, { signal, onProgress, fetcher = fetch, maxPixels = MAX_PIXELS } = {}) {
  const region = visibleRegion(view);
  const limits = { maxZoom: captureZoomLimit(view.source, view.nativeZoom), nativeZoom: view.nativeZoom, maxPixels };
  const plan = ESRI_LIVE_TILES.test(view.template)
    ? await chooseEsriPlan(region, limits, signal, fetcher)
    : await chooseProbedPlan(view, region, limits, signal, fetcher);
  if (!plan) throw new Error('Видима ділянка завелика для фото. Наблизьте карту.');

  const strip = creditHeight(plan.width);
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height + strip;
  const context = canvas.getContext('2d');
  context.fillStyle = '#1c2a33';
  context.fillRect(0, 0, plan.width, plan.height);
  context.imageSmoothingQuality = 'high';

  const parents = new Map();
  const parent = source => {
    const key = `${source.z}/${source.x}/${source.y}`;
    if (!parents.has(key)) parents.set(key, loadBitmap(tileUrl(view.template, source), signal, fetcher).catch(error => { if (signal?.aborted) throw error; return null; }));
    return parents.get(key);
  };
  let done = 0, sharp = 0, fallback = 0, empty = 0;
  const tiles = plan.tiles.filter(tile => tileInBounds(tile, view.bounds));
  empty += plan.tiles.length - tiles.length;
  await pool(tiles, 8, async tile => {
    let bitmap = null;
    if (plan.available?.get(`${tile.x}/${tile.y}`) !== false) {
      try { bitmap = await loadBitmap(tileUrl(view.template, tile), signal, fetcher); }
      catch (error) { if (signal?.aborted) throw error; }
    }
    if (bitmap) {
      context.drawImage(bitmap, tile.drawX, tile.drawY, TILE_SIZE, TILE_SIZE);
      bitmap.close?.();
      sharp += 1;
    } else {
      let drawn = false;
      for (let levelsUp = 1; levelsUp <= 4 && tile.z - levelsUp >= 0 && !drawn; levelsUp += 1) {
        const source = parentSource(tile, levelsUp);
        const image = await parent(source);
        if (image) {
          context.drawImage(image, source.sx, source.sy, source.size, source.size, tile.drawX, tile.drawY, TILE_SIZE, TILE_SIZE);
          drawn = true;
        }
      }
      if (drawn) fallback += 1; else empty += 1;
    }
    onProgress?.(++done, tiles.length);
  });
  for (const pending of parents.values()) pending.then(image => image?.close?.()).catch(() => {});
  if (!sharp && !fallback) throw new Error('Провайдер не віддав жодного тайла для фото.');

  drawCredits(context, plan.width, plan.height, strip, view.credits);
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  const thumb = await thumbnail(canvas);
  const center = unproject(plan.left + plan.width / 2, plan.top + plan.height / 2, plan.zoom);
  const metersPerPixel = 40075016.686 * Math.cos(center.lat * Math.PI / 180) / (TILE_SIZE * 2 ** plan.zoom);
  return {
    blob, thumb, width: canvas.width, height: canvas.height, imageHeight: plan.height,
    captureZoom: plan.zoom, gain: 2 ** (plan.zoom - Math.min(view.zoom, view.displayZoom)),
    metersPerPixel, tiles: { total: plan.tiles.length, sharp, fallback, empty }
  };
}
