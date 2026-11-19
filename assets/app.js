import { SOURCES, readState, providerForId, providerChoices, filterDates, adjacentLayer, layoutSizes, selectLayer, coversPoint, LatestRequest, tileCoordinates } from './catalog.js';
import { loadWayback, loadCatalog, catalogKey, loadSceneById, tileDefinition, fetchJson } from './providers.js';
import { delay, frameTask } from './performance.js';
import { fallbackLayers } from './wayback-fallback.js';
import { BASEMAPS, isBasemap } from './basemaps.js';
import { ProviderHealth, providerLabel } from './provider-health.js';
import { credentials, KEY_SOURCES, redactSecrets } from './credentials.js';
import { setupConnections } from './connections-ui.js';

const $ = id => document.getElementById(id);
const app = document.querySelector('.app');
const stage = $('stage'), toolbar = $('toolbar'), divider = $('divider');
const state = readState(new URL(location.href));
const formatDate = date => date.split('-').reverse().join('.');
// Yearly mosaics are labelled by year rather than by a nominal day.
const dateText = layer => layer.dateLabel || formatDate(layer.date);
const layerCaption = layer => isBasemap(layer.source) ? `${SOURCES[layer.source].name} · ${layer.label}` : dateText(layer);
const views = {};
let healthStorage;
try { healthStorage = window.localStorage; } catch { /* Private browser modes can block storage. */ }
const providerHealth = new ProviderHealth({ storage: healthStorage });
const healthChecks = new Map();
const monthNames = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const isSingle = () => $('singleMapToggle').checked;
const isActive = view => view.side === 'left' || !isSingle();
const needsKey = source => Boolean(BASEMAPS[source]?.requiredKey && !credentials.get(source));
const registry = new Map([...fallbackLayers, ...Object.values(BASEMAPS)].map(layer => [layer.id, layer]));
const catalogRequest = new LatestRequest();
const searchRequest = new LatestRequest();
let wayback = fallbackLayers;
let catalogs = Object.fromEntries(Object.keys(SOURCES).map(source => [source, source === 'esri' ? wayback : isBasemap(source) ? [BASEMAPS[source]] : []]));
const catalogKeys = {};
let pendingSources = new Set();
let failedSources = new Set();
let split = state.split;
let visualZoom = state.visualZoom;
let refreshTimer;
let syncing = false;
let following = false;
let interacting = false;
let ready = false;
let urlTimer;
let layoutWidth = 0;
let waybackPromise;

if (!window.L) {
  $('catalogStatus').textContent = 'Не вдалося завантажити карту. Перевірте інтернет і оновіть сторінку.';
  throw new Error('Leaflet could not be loaded');
}

// Followers emit moveend on every setView; let throttled move events load tiles,
// and issue just one final moveend when the user's gesture finishes.
const SmoothTileLayer = L.TileLayer.extend({
  getEvents() {
    const events = L.TileLayer.prototype.getEvents.call(this);
    const onMoveEnd = events.moveend;
    events.moveend = function (event) { if (!following) onMoveEnd?.call(this, event); };
    return events;
  }
});

for (const side of ['left', 'right']) {
  const provider = state[`${side}Provider`];
  const savedId = state[side] && providerForId(state[side]) === provider ? state[side] : null;
  const map = L.map($(`${side}Map`), {
    attributionControl: false, fadeAnimation: false, zoomControl: false,
    worldCopyJump: true, minZoom: 2, maxZoom: 18, trackResize: false
  }).setView(state.center, state.zoom);
  // Bottom-left, above the date badge: the top corners belong to the panel.
  if (side === 'left') L.control.zoom({ position: 'bottomleft' }).addTo(map);
  const mapPane = map.getPane('mapPane');
  const visualPane = document.createElement('div');
  visualPane.className = 'visual-zoom-pane';
  mapPane.parentNode.insertBefore(visualPane, mapPane);
  visualPane.appendChild(mapPane);
  map.createPane('labelsPane');
  map.getPane('labelsPane').style.zIndex = 450;
  map.getPane('labelsPane').style.pointerEvents = 'none';
  views[side] = {
    side, map, visualPane, select: $(`${side}Layer`), source: $(`${side}Source`),
    meta: $(`${side}Meta`), badge: $(`${side}Badge`), tile: null, labels: null,
    provider, providerSelect: $(`${side}Provider`), yearSelect: $(`${side}Year`), monthSelect: $(`${side}Month`),
    previous: $(`${side}Previous`), next: $(`${side}Next`), position: $(`${side}Position`),
    choices: [], yearFilter: null, monthFilter: 'all',
    layer: null, desiredId: savedId, selectionId: savedId, selectionDate: null,
    mode: savedId ? 'manual' : side === 'left' ? 'oldest' : 'newest',
    request: new LatestRequest(), failed: false, suspended: false,
    pendingTile: null, displayedLayer: null, prefetchTimer: null, controlsKey: ''
  };
  views[side].providerSelect.value = provider;
  for (const item of views[side].providerSelect.options) item.dataset.baseLabel = item.textContent;
}

function renderProviderHealth() {
  for (const view of Object.values(views)) for (const item of view.providerSelect.options) {
    const unconfigured = needsKey(item.value);
    const unavailable = providerHealth.unavailable(item.value);
    const label = unconfigured ? `${item.dataset.baseLabel} 🔑` : providerLabel(item.dataset.baseLabel, unavailable);
    if (item.textContent !== label) item.textContent = label;
    const title = unconfigured ? 'Додайте власний ключ у «API-ключі».' : unavailable ? `Остання спроба не вдалася: ${providerHealth.message(item.value)}` : '';
    if (item.title !== title) item.title = title;
    item.dataset.availability = unconfigured ? 'key-required' : unavailable ? 'unavailable' : providerHealth.needsCheck(item.value) ? 'unknown' : 'available';
  }
}
providerHealth.subscribe(renderProviderHealth);

async function checkBasemapHealth(source) {
  if (needsKey(source) || !providerHealth.needsCheck(source) || healthChecks.has(source)) return;
  if (Object.values(views).some(view => isActive(view) && view.provider === source)) return;
  const revision = providerHealth.revision(source);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const check = (async () => {
    try {
      const layer = BASEMAPS[source];
      const center = views.left.map.getCenter().wrap(), zoom = views.left.map.getZoom();
      const definition = await tileDefinition(layer, controller.signal, fetch, { center, zoom });
      if (source !== 'mapbox') {
        const tile = tileCoordinates(center, Math.min(zoom, definition.nativeZoom));
        const url = definition.template.replace('{z}', tile.level).replace('{x}', tile.column).replace('{y}', tile.row);
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        if ([405, 501].includes(response.status)) return;
        if (!response.ok) throw new Error(`${SOURCES[source].name}: HTTP ${response.status}`);
      }
      if (providerHealth.revision(source) === revision) providerHealth.success(source, 'probe');
    } catch (error) {
      // HEAD/CORS support varies: actual image loading remains the stronger check.
      if (error.name === 'AbortError' || error.name === 'TypeError') return;
      if (providerHealth.revision(source) === revision) providerHealth.failure(source, 'probe', redactSecrets(error.message, KEY_SOURCES.map(item => credentials.get(item))));
    } finally {
      clearTimeout(timeout);
      if (healthChecks.get(source)?.controller === controller) healthChecks.delete(source);
    }
  })();
  healthChecks.set(source, { promise: check, controller });
  return check;
}

async function checkProviders() {
  renderProviderHealth();
  // Check only lightweight mosaics; never download full date archives for a badge.
  const sources = Object.keys(BASEMAPS);
  for (let index = 0; index < sources.length; index += 2) {
    await Promise.allSettled(sources.slice(index, index + 2).map(checkBasemapHealth));
  }
}

function showStatus(text, tone = 'info', timeout = 5000) {
  clearTimeout(showStatus.timer);
  $('status').textContent = redactSecrets(text, KEY_SOURCES.map(source => credentials.get(source)));
  $('status').dataset.tone = tone;
  $('status').hidden = false;
  if (timeout) showStatus.timer = setTimeout(() => { $('status').hidden = true; }, timeout);
}

function writeUrl() {
  if (!ready) return;
  const center = views.left.map.getCenter().wrap();
  const params = new URLSearchParams(location.search);
  for (const name of [...params.keys()]) {
    if (/^(key|api_?key|access_token|maptilerkey|mapboxkey|mapboxtoken|gammakey|ge_api_key)$/i.test(name)) params.delete(name);
  }
  for (const side of ['left', 'right']) {
    const id = views[side].desiredId || views[side].layer?.id;
    if (id) params.set(side, id);
    else params.delete(side);
    params.set(`${side}Provider`, views[side].provider);
  }
  params.set('split', split.toFixed(3));
  params.set('visualZoom', String(visualZoom));
  params.set('magnify', $('visualZoomToggle').checked ? '1' : '0');
  params.set('labels', $('labelsToggle').checked ? '1' : '0');
  params.set('mode', isSingle() ? 'single' : $('separateModeToggle').checked ? 'separate' : 'split');
  if (isSingle()) params.set('comparison', $('separateModeToggle').checked ? 'separate' : 'split');
  else params.delete('comparison');
  params.set('slider', $('hideSliderToggle').checked ? '0' : '1');
  params.delete('hideSlider');
  params.set('panel', app.classList.contains('panel-collapsed') ? '0' : '1');
  const next = `${location.pathname}?${params}#${views.left.map.getZoom()}/${center.lat.toFixed(6)}/${center.lng.toFixed(6)}`;
  if (next !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, '', next);
}

function updateUrl(immediate = false) {
  clearTimeout(urlTimer);
  if (immediate === true) writeUrl();
  else urlTimer = setTimeout(writeUrl, 160);
}

function positionPanelToggle() {
  const collapsed = app.classList.contains('panel-collapsed');
  // On wide screens the panel is a top bar plus a card at each side: anchor to the bar.
  const bar = getComputedStyle($('topbar')).display === 'contents' ? toolbar : $('topbar');
  $('panelToggle').style.top = collapsed ? '8px' : `${bar.offsetHeight + 6}px`;
  $('panelToggle').textContent = collapsed ? 'Панель' : 'Сховати';
  $('panelToggle').setAttribute('aria-expanded', String(!collapsed));
  toolbar.inert = collapsed;
}

function applyLayout(invalidate = false) {
  const center = views.left.map.getCenter();
  const zoom = views.left.map.getZoom();
  const width = stage.clientWidth, height = stage.clientHeight;
  layoutWidth = width;
  const single = isSingle();
  const sizes = layoutSizes(width, split, $('separateModeToggle').checked, single);
  const separate = sizes.separate;
  const splitPx = sizes.left;
  app.classList.toggle('single-mode', single);
  stage.classList.toggle('single', single);
  stage.classList.toggle('separate', separate);
  $('rightClip').hidden = single;
  $('rightControls').hidden = single;
  $('rightBadge').hidden = single;
  $('separateModeToggle').disabled = single;
  $('hideSliderToggle').disabled = single;
  $('modeHint').textContent = single ? 'Перегляд одного знімка' : 'Порівняння двох дат';
  document.querySelector('label[for="leftProvider"]').textContent = single ? 'Провайдер карти' : 'Провайдер ліворуч';
  document.querySelector('label[for="leftLayer"]').textContent = single ? 'Дата знімка' : 'Дата ліворуч';
  $('leftControls').setAttribute('aria-label', single ? 'Налаштування карти' : 'Налаштування лівої карти');
  divider.hidden = single || separate || $('hideSliderToggle').checked;
  $('leftClip').style.width = `${splitPx}px`;
  $('rightClip').style.left = `${splitPx}px`;
  $('rightClip').style.width = `${sizes.right}px`;
  divider.style.left = `${splitPx}px`;
  divider.setAttribute('aria-valuenow', String(Math.round(split * 100)));
  for (const side of ['left', 'right']) {
    if (single && side === 'right') continue;
    const canvas = $(`${side}Map`);
    canvas.style.width = `${separate ? (side === 'left' ? splitPx : width - splitPx) : width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.left = side === 'right' && !separate ? `${-splitPx}px` : '0';
    if (invalidate) {
      views[side].map.invalidateSize({ animate: false, pan: false });
      views[side].map.setView(center, zoom, { animate: false });
    }
  }
}

function setVisualZoom() {
  const enabled = $('visualZoomToggle').checked;
  visualZoom = enabled ? Number($('visualZoom').value) : 100;
  $('visualZoomControl').hidden = !enabled;
  $('visualZoomValue').value = `${visualZoom}%`;
  for (const view of Object.values(views)) view.visualPane.style.transform = `scale(${visualZoom / 100})`;
  positionPanelToggle();
  updateUrl();
}

function setLabels() {
  for (const view of Object.values(views)) {
    if (isActive(view) && $('labelsToggle').checked && !view.labels) {
      view.labels = new SmoothTileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
        pane: 'labelsPane', maxNativeZoom: 18, maxZoom: 18, keepBuffer: 3, updateWhenIdle: false, updateInterval: 180
      }).addTo(view.map);
    } else if ((!isActive(view) || !$('labelsToggle').checked) && view.labels) {
      view.map.removeLayer(view.labels);
      view.labels = null;
    }
  }
  updateUrl();
}

function metadata(layer) {
  if (isBasemap(layer.source)) return layer.source === 'esri-clarity'
    ? 'Архів для чіткості · дата залежить від ділянки'
    : 'Поточна мозаїка · дата залежить від ділянки';
  if (layer.source === 'esri') return 'Дата публікації карти; зйомка може бути давнішою';
  if (layer.source === 'eox') return `Безхмарна мозаїка за ${layer.itemId} рік · 10 м/пікс.`;
  if (layer.source === 'modis') return 'Щоденний знімок NASA · 250 м/пікс. · хмари не відфільтровані';
  const cloud = Number.isFinite(layer.cloud) ? ` · хмари ${Math.round(layer.cloud)}%` : '';
  return `Дата зйомки · ${layer.resolution} м/пікс.${cloud}`;
}

function updateImageryAttribution() {
  const credits = new Set();
  for (const view of Object.values(views).filter(isActive)) {
    const layer = view.displayedLayer;
    if (!layer?.attribution || !layer.source.startsWith('esri')) continue;
    const names = layer.attribution.replace(/^Source:\s*/i, '').replace(/,\s*and\s+/g, ', ').split(',').map(name => name.trim());
    for (const name of names) if (name) credits.add(name);
  }
  const text = credits.size ? `Знімки: ${[...credits].join(', ')}` : '';
  if ($('imageryAttribution').textContent !== text) $('imageryAttribution').textContent = text;
  const shown = new Set(Object.values(views).filter(isActive).map(view => view.displayedLayer?.source).filter(Boolean));
  for (const element of document.querySelectorAll('[data-imagery-sources]')) {
    element.hidden = !element.dataset.imagerySources.split(' ').some(source => shown.has(source));
  }
  $('providerLogos').hidden = ![...shown].some(source => BASEMAPS[source]?.requiresLogo);
}

async function displayLayer(view, layer, retry = false, waitMs = 0) {
  if (!isActive(view) || layer.source !== view.provider) return;
  if (view.layer?.id === layer.id && !retry && !view.suspended) return;
  const request = view.request.begin(layer.id);
  clearTimeout(view.prefetchTimer);
  clearTimeout(view.tileDeadline);
  if (view.pendingTile) { view.map.removeLayer(view.pendingTile); view.pendingTile = null; }
  view.layer = layer;
  view.suspended = false;
  if (view.mode === 'manual' && !view.selectionDate) view.selectionDate = layer.date;
  view.failed = false;
  view.source.textContent = `(${SOURCES[layer.source].name})`;
  view.source.title = isBasemap(layer.source) ? layer.title : layer.source === 'esri' ? 'Esri World Imagery Wayback'
    : layer.source === 'eox' ? 'Sentinel-2 cloudless · EOX IT Services GmbH' : layer.source === 'modis' ? 'MODIS Terra · NASA GIBS'
    : `${SOURCES[layer.source].name} · Microsoft Planetary Computer`;
  view.meta.textContent = metadata(layer);
  view.meta.title = layer.note || metadata(layer);
  view.badge.textContent = view.displayedLayer
    ? `${layerCaption(view.displayedLayer)} · завантажуємо ${layerCaption(layer)}…`
    : `${layerCaption(layer)} · завантаження…`;
  view.badge.setAttribute('aria-busy', 'true');
  updateUrl();
  const fail = rawMessage => {
    if (!view.request.isCurrent(request)) return;
    const message = redactSecrets(rawMessage, KEY_SOURCES.map(source => credentials.get(source)));
    clearTimeout(view.tileDeadline);
    if (view.pendingTile) { view.map.removeLayer(view.pendingTile); view.pendingTile = null; }
    view.failed = true;
    view.lastError = message;
    providerHealth.failure(layer.source, 'imagery', message);
    view.meta.textContent = message;
    view.meta.title = message;
    view.badge.setAttribute('aria-busy', 'false');
    view.badge.textContent = view.displayedLayer
      ? `${layerCaption(view.displayedLayer)} · новий знімок недоступний`
      : `${layerCaption(layer)} · недоступно`;
    $('retryCatalog').hidden = false;
    showStatus(message, 'error', /429|HTTP 40[123]/.test(message) ? 0 : 8000);
  };
  if (needsKey(layer.source)) {
    view.meta.textContent = `Додайте власний ключ ${layer.shortName} у «API-ключі».`;
    view.meta.title = view.meta.textContent;
    view.badge.setAttribute('aria-busy', 'false');
    view.badge.textContent = view.displayedLayer ? `${layerCaption(view.displayedLayer)} · потрібен ключ ${layer.shortName}` : `${layer.shortName} · потрібен власний ключ`;
    return;
  }
  try {
    if (waitMs) await delay(waitMs, request.signal);
    const definition = await tileDefinition(layer, request.signal, fetch, { center: view.map.getCenter().wrap(), zoom: view.map.getZoom() });
    if (!view.request.isCurrent(request)) return;
    const options = { opacity: 0, zIndex: 2, crossOrigin: true, keepBuffer: 3, maxNativeZoom: definition.nativeZoom, maxZoom: 18, updateWhenIdle: false, updateInterval: 180, updateWhenZooming: false };
    if (definition.bounds) {
      const [west, south, east, north] = definition.bounds;
      options.bounds = [[south, west], [north, east]];
      options.noWrap = true;
    }
    const tile = new SmoothTileLayer(definition.template, options);
    let loaded = 0, errors = 0, presented = false;
    tile.on('loading', () => { loaded = 0; errors = 0; });
    tile.on('tileload', () => { loaded += 1; });
    tile.on('tileerror', () => { errors += 1; });
    tile.on('load', () => {
      if (!view.request.isCurrent(request)) return;
      if (errors && !loaded) {
        fail(`Не вдалося завантажити знімок ${SOURCES[layer.source].name}. ${isBasemap(layer.source) ? 'Спробуйте іншу карту' : 'Спробуйте іншу дату'} або повторіть запит.`);
      } else {
        clearTimeout(view.tileDeadline);
        if (!presented) {
          const previous = view.tile;
          view.tile = tile;
          view.pendingTile = null;
          view.displayedLayer = layer;
          updateImageryAttribution();
                  tile.setOpacity(1).setZIndex(1);
          if (previous) view.map.removeLayer(previous);
          presented = true;
          prefetchNeighbors(view);
        }
        view.failed = false;
        providerHealth.success(layer.source, 'imagery');
        if (view.lastError && $('status').textContent === view.lastError) $('status').hidden = true;
        view.lastError = null;
        view.meta.textContent = metadata(layer);
        view.meta.title = layer.note || metadata(layer);
        view.badge.setAttribute('aria-busy', 'false');
        view.badge.textContent = isBasemap(layer.source) ? layerCaption(layer) : `${dateText(layer)} · ${SOURCES[layer.source].name}${layer.resolution ? ` · ${layer.resolution} м` : ''}`;
      }
    });
    view.pendingTile = tile;
    view.tileDeadline = setTimeout(() => fail('Знімок завантажується занадто довго. Попередній кадр залишено на карті; можна повторити запит.'), 20000);
    tile.addTo(view.map);
  } catch (error) {
    if (!view.request.isCurrent(request)) return;
    fail(`Знімок ${SOURCES[layer.source].name} не завантажився. ${error.message}`);
  }
}

function prefetchNeighbors(view) {
  clearTimeout(view.prefetchTimer);
  if (isBasemap(view.provider) || view.provider === 'esri' || navigator.connection?.saveData || /(^|-)2g$/.test(navigator.connection?.effectiveType || '')) return;
  view.prefetchTimer = setTimeout(() => {
    if (!isActive(view) || view.failed) return;
    const neighbors = ['older', 'newer'].map(direction => adjacentLayer(view.choices, view.layer?.id, direction)).filter(Boolean);
    // Only tiny metadata documents; imagery is never downloaded speculatively.
    Promise.allSettled(neighbors.map(layer => tileDefinition(layer)));
  }, 400);
}

function availableLayers() {
  const center = views.left.map.getCenter().wrap();
  const sources = [...new Set(Object.values(views).filter(isActive).map(view => view.provider))];
  const combined = new Map(sources.flatMap(source => catalogs[source]).filter(layer => coversPoint(layer, center)).map(layer => [layer.id, layer]));
  // A refresh must not silently replace a date the user already selected.
  for (const view of Object.values(views)) {
    const selected = registry.get(view.desiredId || view.selectionId) || view.layer;
    if (selected && coversPoint(selected, center)) combined.set(selected.id, selected);
  }
  return [...combined.values()];
}

function option(value, label) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

function suspendView(view, keepDisplayed = false) {
  view.request.cancel();
  clearTimeout(view.prefetchTimer);
  clearTimeout(view.tileDeadline);
  if (view.pendingTile) { view.map.removeLayer(view.pendingTile); view.pendingTile = null; }
  if (!keepDisplayed) {
    if (view.tile) { view.map.removeLayer(view.tile); view.tile = null; }
    view.displayedLayer = null;
  }
  updateImageryAttribution();
  view.badge.setAttribute('aria-busy', 'false');
  view.suspended = true;
}

function renderDateControls(view, choices, selected) {
  view.choices = choices;
  const mosaic = isBasemap(view.provider);
  const card = $(`${view.side}Controls`);
  card.querySelector('.period-filters').hidden = mosaic;
  card.querySelector('.date-navigation').hidden = mosaic;
  card.classList.toggle('basemap-card', mosaic);
  if (mosaic) {
    view.select.replaceChildren(option(selected.id, selected.label));
    view.select.disabled = true;
    view.yearSelect.replaceChildren(option('', '—'));
    view.monthSelect.replaceChildren(option('', '—'));
    view.yearSelect.disabled = view.monthSelect.disabled = true;
    view.previous.disabled = view.next.disabled = true;
    view.datesKey = view.yearsKey = view.monthsKey = null;
    return;
  }
  const years = [...new Set(choices.map(layer => layer.date.slice(0, 4)))];
  if (!view.yearFilter || (view.yearFilter !== 'all' && !years.includes(view.yearFilter))) view.yearFilter = selected.date.slice(0, 4);
  if (!filterDates(choices, view.yearFilter, view.monthFilter).some(layer => layer.id === selected.id)) {
    if (view.yearFilter !== 'all') view.yearFilter = selected.date.slice(0, 4);
    if (view.monthFilter !== 'all') view.monthFilter = selected.date.slice(5, 7);
  }
  const yearsKey = years.join(',');
  if (view.yearsKey !== yearsKey) {
    view.yearSelect.replaceChildren(option('all', 'Усі роки'), ...years.map(year => option(year, year)));
    view.yearsKey = yearsKey;
  }
  view.yearSelect.value = view.yearFilter;
  const months = [...new Set(filterDates(choices, view.yearFilter).map(layer => layer.date.slice(5, 7)))].sort();
  if (view.monthFilter !== 'all' && !months.includes(view.monthFilter)) view.monthFilter = 'all';
  const monthsKey = months.join(',');
  if (view.monthsKey !== monthsKey) {
    view.monthSelect.replaceChildren(option('all', 'Усі місяці'), ...months.map(month => option(month, monthNames[Number(month) - 1])));
    view.monthsKey = monthsKey;
  }
  view.monthSelect.value = view.monthFilter;
  const filtered = filterDates(choices, view.yearFilter, view.monthFilter);
  const datesKey = filtered.map(layer => layer.id).join(',');
  if (view.datesKey !== datesKey) {
    view.select.replaceChildren(...filtered.map(layer => option(layer.id, dateText(layer))));
    view.datesKey = datesKey;
  }
  view.select.value = selected.id;
  for (const select of [view.select, view.yearSelect, view.monthSelect]) select.disabled = false;
  const older = adjacentLayer(choices, selected.id, 'older');
  const newer = adjacentLayer(choices, selected.id, 'newer');
  view.previous.disabled = !older;
  view.next.disabled = !newer;
  view.previous.title = older ? `Попередня дата: ${dateText(older)}` : 'Це найдавніша доступна дата';
  view.next.title = newer ? `Наступна дата: ${dateText(newer)}` : 'Це найновіша доступна дата';
  view.position.textContent = `${choices.length - choices.findIndex(layer => layer.id === selected.id)} з ${choices.length}`;
}

function chooseDate(view, layer) {
  if (!layer || layer.source !== view.provider) return;
  view.desiredId = null;
  view.mode = 'manual';
  view.selectionId = layer.id;
  view.selectionDate = layer.date;
  renderDateControls(view, view.choices, layer);
  displayLayer(view, layer, false, 90);
}

const renderCatalog = frameTask(renderCatalogNow);
function renderCatalogNow() {
  if (interacting) return;
  const available = availableLayers();
  const active = Object.values(views).filter(isActive);
  for (const view of active) {
    const preferredId = view.desiredId || (view.mode === 'manual' ? view.selectionId : view.layer?.id);
    const choices = providerChoices(available, view.provider, preferredId);
    view.choices = choices;
    if (!choices.length || (view.desiredId && !choices.some(layer => layer.id === view.desiredId))) {
      const loading = pendingSources.has(view.provider) || Boolean(view.desiredId);
      const message = view.desiredId ? 'Відновлення дати…' : loading ? 'Завантаження дат…' : 'Немає доступних дат';
      view.select.replaceChildren(option(view.desiredId || '', message));
      view.datesKey = view.yearsKey = view.monthsKey = null;
      view.select.disabled = !choices.length;
      // A saved scene may still be loading; allow choosing a known date instead.
      for (const layer of choices) view.select.appendChild(option(layer.id, dateText(layer)));
      view.select.value = view.desiredId || '';
      for (const select of [view.yearSelect, view.monthSelect]) { select.replaceChildren(option('', '—')); select.disabled = true; }
      view.previous.disabled = true; view.next.disabled = true;
      view.position.textContent = loading ? 'Шукаємо знімки…' : '0 дат';
      view.source.textContent = `(${SOURCES[view.provider].name})`;
      if (!view.desiredId) {
        suspendView(view);
        view.badge.textContent = `${SOURCES[view.provider].name} · ${message.toLowerCase()}`;
        view.badge.setAttribute('aria-busy', String(loading));
        view.meta.textContent = loading ? 'Дати для центру карти' : 'Спробуйте інше місце або провайдера';
      }
      continue;
    }
    const selected = selectLayer(choices, { id: preferredId, mode: view.mode, date: view.selectionDate || view.layer?.date });
    view.desiredId = null;
    renderDateControls(view, choices, selected);
    displayLayer(view, selected);
  }
  const sources = [...new Set(active.map(view => view.provider))];
  const counts = sources.map(source => isBasemap(source) ? `${SOURCES[source].name} · підкладка` : `${SOURCES[source].name}: ${providerChoices(available, source).length} дат`).join(' · ');
  const loading = [...pendingSources].map(source => SOURCES[source].name).join(', ');
  const errors = [...failedSources].map(source => SOURCES[source].name).join(', ');
  $('catalogStatus').textContent = `${sources.every(isBasemap) ? 'Детальні карти' : 'Для центру карти'} · ${counts}${loading ? ` · шукаємо ${loading}…` : ''}${errors ? ` · недоступно: ${errors}` : ''}`;
  $('catalogStatus').setAttribute('aria-busy', String(pendingSources.size > 0));
  $('retryCatalog').hidden = !failedSources.size && !active.some(view => view.failed);
  updateUrl();
}

function catalogScope() {
  const center = views.left.map.getCenter().wrap(), zoom = views.left.map.getZoom();
  const sources = [...new Set(Object.values(views).filter(isActive).map(view => view.provider))].sort();
  return sources.map(source => catalogKey(source, center, zoom, wayback)).join('|');
}

function pruneRegistry() {
  const retained = Object.values(views).flatMap(view => [registry.get(view.desiredId), registry.get(view.selectionId), view.layer, view.displayedLayer]).filter(Boolean);
  registry.clear();
  for (const layer of [...wayback, ...Object.values(catalogs).flat(), ...retained]) registry.set(layer.id, layer);
}

async function refreshCatalog(force = false) {
  clearTimeout(refreshTimer);
  const center = views.left.map.getCenter().wrap();
  const zoom = views.left.map.getZoom();
  const scope = catalogScope();
  if (!force && catalogRequest.current?.key === scope && catalogRequest.isCurrent(catalogRequest.current)) { renderCatalog(); return; }
  const request = catalogRequest.begin(scope);
  const sources = [...new Set(Object.values(views).filter(isActive).map(view => view.provider))];
  pendingSources = new Set(sources);
  failedSources = new Set();
  for (const source of Object.keys(catalogs)) {
    const key = catalogKey(source, center, zoom, wayback);
    if (!sources.includes(source)) catalogs[source] = [];
    else if (catalogKeys[source] !== key || !catalogs[source].length) catalogs[source] = source === 'esri' ? wayback : isBasemap(source) ? [BASEMAPS[source]] : [];
    catalogKeys[source] = key;
  }
  renderCatalog();
  if (sources.includes('esri')) ensureWayback();
  const stillCurrent = () => catalogRequest.isCurrent(request) && catalogScope() === scope;
  await Promise.allSettled(sources.map(async source => {
    try {
      const layers = await loadCatalog(source, wayback, center, zoom, request.signal, force);
      if (!stillCurrent()) return;
      // A missing local-change response still leaves the complete Esri archive usable.
      catalogs[source] = source === 'esri' && !layers.length ? wayback : layers;
      providerHealth.success(source, 'catalog');
      pruneRegistry();
    } catch (error) {
      if (!stillCurrent()) return;
      failedSources.add(source);
      providerHealth.failure(source, 'catalog', `Список дат: ${error.message || 'сервіс не відповідає'}`);
    } finally {
      if (stillCurrent()) {
        pendingSources.delete(source);
        renderCatalog();
      }
    }
  }));
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshCatalog, 400);
}

function ensureWayback() {
  if (waybackPromise) return waybackPromise;
  waybackPromise = loadWayback().then(layers => {
    const changed = layers.length !== wayback.length || layers[0]?.id !== wayback[0]?.id;
    wayback = layers;
    for (const layer of layers) registry.set(layer.id, layer);
    if (changed) refreshCatalog();
    for (const view of Object.values(views)) {
      if (isActive(view) && view.desiredId && view.provider === 'esri' && !registry.has(view.desiredId)) {
        view.desiredId = null;
        showStatus('Дату Esri з посилання не знайдено. Виберіть доступну дату.', 'error', 7000);
        renderCatalog();
      }
    }
  }).catch(() => {
    waybackPromise = null;
    showStatus('Esri тимчасово недоступний. Використовуємо збережений каталог дат.', 'info', 7000);
  });
  return waybackPromise;
}

function syncMaps(source, target) {
  let frame;
  const sync = () => {
    frame = null;
    if (isSingle() || syncing || (source.getZoom() === target.getZoom() && source.getCenter().distanceTo(target.getCenter()) < 0.1)) return;
    syncing = true;
    following = true;
    try { target.setView(source.getCenter(), source.getZoom(), { animate: false, noMoveStart: true }); }
    finally { following = false; syncing = false; }
  };
  source.on('move zoom', () => {
    if (!syncing && !frame) frame = requestAnimationFrame(sync);
  });
  source.on('moveend zoomend', event => {
    if (syncing || event.synchronized) return;
    if (frame) cancelAnimationFrame(frame);
    sync();
    interacting = false;
    if (!isSingle()) target.fire('moveend', { synchronized: true });
    updateUrl();
    scheduleRefresh();
  });
}

async function searchLocation(event) {
  event.preventDefault();
  const query = $('searchBox').value.trim();
  if (!query) return;
  const request = searchRequest.begin(query);
  showStatus('Шукаємо місце…', 'info', 0);
  try {
    const params = new URLSearchParams({ format: 'jsonv2', limit: '1', q: query });
    const results = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`, request.signal);
    if (!searchRequest.isCurrent(request)) return;
    const lat = Number(results[0]?.lat), lng = Number(results[0]?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Місце не знайдено');
    views.left.map.setView([lat, lng], Math.max(views.left.map.getZoom(), 14), { animate: false });
    showStatus(results[0].display_name);
  } catch (error) { if (searchRequest.isCurrent(request)) showStatus(error.message, 'error'); }
}

async function restoreSavedScenes() {
  await Promise.allSettled(Object.values(views).map(async view => {
    if (!isActive(view)) return;
    if (isBasemap(view.provider)) return;
    const id = view.desiredId;
    if (!id || !id.includes(':')) return;
    try {
      const layer = await loadSceneById(id);
      if (view.desiredId !== id) return; // The user chose another date while loading.
      if (!layer || !coversPoint(layer, views.left.map.getCenter().wrap())) throw new Error('Збережений знімок не покриває центр карти');
      registry.set(layer.id, layer);
    } catch (error) {
      if (view.desiredId !== id) return;
      view.desiredId = null;
      showStatus('Збережений знімок недоступний для цього місця. Виберіть дату зі списку.', 'error', 8000);
    }
    renderCatalog();
  }));
}

$('singleMapToggle').checked = state.single;
$('labelsToggle').checked = state.labels;
$('separateModeToggle').checked = state.separate;
$('hideSliderToggle').checked = state.hideSlider;
$('visualZoomToggle').checked = state.magnify;
$('visualZoom').value = state.visualZoom;
app.classList.toggle('panel-collapsed', state.collapsed);
applyLayout(true);
setVisualZoom();
setLabels();
syncMaps(views.left.map, views.right.map);
syncMaps(views.right.map, views.left.map);

for (const view of Object.values(views)) {
  view.providerSelect.addEventListener('focus', checkProviders);
  view.providerSelect.addEventListener('change', () => {
    $('status').hidden = true;
    const date = view.selectionDate || view.layer?.date;
    suspendView(view, true);
    view.provider = view.providerSelect.value;
    view.layer = null; view.desiredId = null; view.selectionId = null;
    view.selectionDate = date; view.mode = date ? 'manual' : view.side === 'left' ? 'oldest' : 'newest';
    view.yearFilter = null; view.monthFilter = 'all'; view.failed = false;
    refreshCatalog();
    if (needsKey(view.provider)) connections.open(view.provider);
  });
  view.select.addEventListener('change', () => {
    const layer = registry.get(view.select.value);
    chooseDate(view, layer);
  });
  view.yearSelect.addEventListener('change', () => {
    view.yearFilter = view.yearSelect.value;
    view.monthFilter = 'all';
    chooseDate(view, selectLayer(filterDates(view.choices, view.yearFilter), {mode: 'manual', date: view.layer?.date}));
  });
  view.monthSelect.addEventListener('change', () => {
    view.monthFilter = view.monthSelect.value;
    chooseDate(view, selectLayer(filterDates(view.choices, view.yearFilter, view.monthFilter), {mode: 'manual', date: view.layer?.date}));
  });
  view.previous.addEventListener('click', () => chooseDate(view, adjacentLayer(view.choices, view.layer?.id, 'older')));
  view.next.addEventListener('click', () => chooseDate(view, adjacentLayer(view.choices, view.layer?.id, 'newer')));
  view.map.on('movestart zoomstart', () => { if (!syncing) interacting = true; });
}
// The centre marker is faint at rest and clear while the map moves (dates follow this point).
let centerTimer;
views.left.map.on('movestart zoomstart', () => { clearTimeout(centerTimer); stage.classList.add('map-moving'); });
views.left.map.on('moveend zoomend', () => { clearTimeout(centerTimer); centerTimer = setTimeout(() => stage.classList.remove('map-moving'), 900); });
toolbar.addEventListener('submit', searchLocation);
$('labelsToggle').addEventListener('change', setLabels);
$('visualZoomToggle').addEventListener('change', setVisualZoom);
$('visualZoom').addEventListener('input', frameTask(setVisualZoom));
for (const id of ['separateModeToggle', 'hideSliderToggle']) $(id).addEventListener('change', () => { applyLayout(true); updateUrl(); });
$('singleMapToggle').addEventListener('change', () => {
  if (isSingle()) suspendView(views.right);
  applyLayout(true);
  setLabels();
  renderCatalog();
  restoreSavedScenes();
  refreshCatalog();
});
$('panelToggle').addEventListener('click', () => { app.classList.toggle('panel-collapsed'); positionPanelToggle(); updateUrl(); });
$('retryCatalog').addEventListener('click', () => {
  for (const view of Object.values(views)) if (isActive(view) && view.failed && view.layer) displayLayer(view, view.layer, true);
  refreshCatalog(true);
});
$('shareButton').addEventListener('click', async () => {
  updateUrl(true);
  try { await navigator.clipboard.writeText(location.href); showStatus('Посилання скопійовано.'); }
  catch { showStatus(location.href, 'info', 12000); }
});

let pointer = null, dividerBounds;
const drawSplit = frameTask(() => {
  if (isSingle() || $('separateModeToggle').checked) return;
  const x = Math.round(layoutWidth * split);
  $('leftClip').style.width = `${x}px`;
  $('rightClip').style.left = `${x}px`;
  $('rightClip').style.width = `${layoutWidth - x}px`;
  $('rightMap').style.left = `${-x}px`;
  divider.style.left = `${x}px`;
  divider.setAttribute('aria-valuenow', String(Math.round(split * 100)));
});
const moveDivider = clientX => {
  const rect = dividerBounds;
  split = Math.max(0.12, Math.min(0.88, (clientX - rect.left) / rect.width));
  drawSplit(); updateUrl();
};
divider.addEventListener('pointerdown', event => {
  if (divider.hidden) return;
  dividerBounds = stage.getBoundingClientRect();
  pointer = event.pointerId; divider.setPointerCapture(pointer); moveDivider(event.clientX);
});
divider.addEventListener('pointermove', event => { if (event.pointerId === pointer) moveDivider(event.clientX); });
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) divider.addEventListener(type, () => { pointer = null; updateUrl(true); });
divider.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault(); split = Math.max(0.12, Math.min(0.88, split + (event.key === 'ArrowLeft' ? -0.03 : 0.03)));
  drawSplit(); updateUrl();
});
new ResizeObserver(frameTask(positionPanelToggle)).observe(toolbar);
new ResizeObserver(frameTask(() => {
  app.style.setProperty('--attribution-height', `${Math.ceil(document.querySelector('.attribution').offsetHeight)}px`);
})).observe(document.querySelector('.attribution'));
const resizeLayout = frameTask(() => { applyLayout(true); positionPanelToggle(); });
window.addEventListener('resize', resizeLayout);
new ResizeObserver(resizeLayout).observe(stage);

const connections = setupConnections({
  store: credentials,
  getView: () => ({ center: views.left.map.getCenter().wrap(), zoom: views.left.map.getZoom() }),
  onCheckResult(source, ok, message, key) {
    if (!BASEMAPS[source] || !key || credentials.get(source) !== key) return;
    if (ok) providerHealth.success(source, 'probe');
    else providerHealth.failure(source, 'probe', message);
  },
  onApplied: message => showStatus(message, 'info', 7000)
});
credentials.subscribe(changed => {
  for (const source of changed) {
    healthChecks.get(source)?.controller.abort(); healthChecks.delete(source);
    providerHealth.forget(source);
  }
  for (const view of Object.values(views)) {
    const removeDisplayed = changed.includes(view.displayedLayer?.source);
    if (changed.includes(view.provider)) {
      const layer = view.layer || BASEMAPS[view.provider];
      suspendView(view, !removeDisplayed);
      view.layer = null;
      if (layer && isActive(view)) displayLayer(view, layer, true);
    } else if (removeDisplayed) {
      if (view.tile) view.map.removeLayer(view.tile);
      view.tile = null; view.displayedLayer = null;
    }
  }
  updateImageryAttribution(); renderProviderHealth();
  checkProviders();
});

// Photo history was removed; free the space its IndexedDB database took (up to 400 MB).
try { globalThis.indexedDB?.deleteDatabase('datsiuk-map-photos'); } catch {}

ready = true;
renderProviderHealth();
setTimeout(checkProviders, 1200);
renderCatalog();
restoreSavedScenes();
refreshCatalog();
