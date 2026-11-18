const ESRI_LIFECYCLE_URL = 'https://www.esri.com/arcgis-blog/products/arcgis-living-atlas/announcements/sunsetting-legacy-basemaps';

// These layers are mosaics, not dated acquisitions or Wayback releases.
// Keep date null so they cannot be mistaken for imagery captured today.
export const BASEMAPS = Object.freeze({
  'esri-live': Object.freeze({
    id: 'basemap:esri-live',
    source: 'esri-live',
    title: 'Esri World Imagery',
    displayName: 'Esri — поточна карта',
    shortName: 'Esri',
    label: 'Поточне покриття',
    note: 'Супутникова мозаїка Esri. Дата зйомки залежить від ділянки; це не дата відкриття карти.',
    date: null,
    dateKind: 'mosaic',
    resolution: null,
    nativeZoom: 19,
    template: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
    attributionUrl: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    lifecycle: 'active',
    retirementMonth: null,
    lifecycleUrl: null
  }),
  'esri-clarity': Object.freeze({
    id: 'basemap:esri-clarity',
    source: 'esri-clarity',
    title: 'Esri World Imagery (Clarity)',
    displayName: 'Esri Clarity — архів',
    shortName: 'Clarity',
    label: 'Архів Clarity',
    note: 'Архівна мозаїка Esri Clarity, не оновлюється з 2022 року. Дата зйомки залежить від ділянки. Закриття сервісу заплановане на березень 2028 року.',
    date: null,
    dateKind: 'mosaic',
    resolution: null,
    nativeZoom: 19,
    template: 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Source: Esri, Vantor, Earthstar Geographics, IGN, and the GIS User Community',
    attributionUrl: 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer',
    lifecycle: 'archived',
    retirementMonth: '2028-03',
    lifecycleUrl: ESRI_LIFECYCLE_URL
  }),
  maptiler: Object.freeze({
    id: 'basemap:maptiler',
    source: 'maptiler',
    title: 'MapTiler Satellite',
    displayName: 'MapTiler Satellite',
    shortName: 'MapTiler',
    label: 'Поточне покриття',
    note: 'Супутникова й аерофотознімальна мозаїка MapTiler. Дата зйомки та деталізація залежать від ділянки; це не архів із вибором дат.',
    date: null,
    dateKind: 'mosaic',
    resolution: null,
    nativeZoom: 19,
    template: null,
    metadataUrl: 'https://api.maptiler.com/tiles/satellite-v2/tiles.json?key={key}',
    requiredKey: 'maptiler',
    attribution: '© MapTiler © OpenStreetMap contributors',
    attributionUrl: 'https://www.maptiler.com/copyright/',
    requiresLogo: true,
    logoAsset: './assets/branding/maptiler-logo.svg',
    logoHref: 'https://www.maptiler.com/',
    logoAlt: 'MapTiler',
    lifecycle: 'active',
    retirementMonth: null,
    lifecycleUrl: null
  }),
  mapbox: Object.freeze({
    id: 'basemap:mapbox',
    source: 'mapbox',
    title: 'Mapbox Satellite',
    displayName: 'Mapbox Satellite',
    shortName: 'Mapbox',
    label: 'Поточне покриття',
    note: 'Супутникова й аерофотознімальна мозаїка Mapbox. Дата зйомки та деталізація залежать від ділянки; це не архів із вибором дат.',
    date: null,
    dateKind: 'mosaic',
    resolution: null,
    nativeZoom: 19,
    template: 'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg90?access_token={key}',
    metadataUrl: 'https://api.mapbox.com/v4/mapbox.satellite.json?access_token={key}',
    requiredKey: 'mapbox',
    attribution: '© Mapbox © OpenStreetMap © Maxar',
    attributionUrl: 'https://www.mapbox.com/about/maps/',
    feedbackUrl: 'https://apps.mapbox.com/feedback/',
    requiresLogo: true,
    logoAsset: './assets/branding/mapbox-logo.svg',
    logoHref: 'https://www.mapbox.com/',
    logoAlt: 'Mapbox',
    lifecycle: 'active',
    retirementMonth: null,
    lifecycleUrl: null
  })
});

export function isBasemap(source) {
  return typeof source === 'string' && Object.hasOwn(BASEMAPS, source);
}

export function basemapLayer(source) {
  return isBasemap(source) ? { ...BASEMAPS[source] } : null;
}
