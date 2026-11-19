import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, readState, providerForId, providerChoices, filterDates, adjacentLayer, layoutSizes, dateChoices, selectLayer, coversPoint, LatestRequest, tileCoordinates } from '../assets/catalog.js';
import { loadCatalog, loadScenes, loadSceneById, sceneLayer, fetchJson, localWayback, tileDefinition } from '../assets/providers.js';
import { fallbackLayers } from '../assets/wayback-fallback.js';

const layer = (id, date, source = 'esri', extra = {}) => ({ id, date, source, ...extra });
const scene = (id, date, collection = 'landsat-c2-l2') => ({
  id, collection, properties: { datetime: `${date}T10:00:00Z`, 'eo:cloud_cover': 12 },
  bbox: [29, 49, 32, 52], geometry: { type: 'Polygon', coordinates: [[[29,49],[32,49],[32,52],[29,52],[29,49]]] },
  assets: { tilejson: { href: `https://planetarycomputer.microsoft.com/api/data/v1/item/tilejson.json?collection=${collection}&item=${id}` } }
});
const response = data => ({ ok: true, json: async () => data });

test('malformed split cannot create NaN layout and coordinates are bounded', () => {
  for (const split of ['abc', 'NaN', 'Infinity', '']) assert.equal(readState(new URL(`https://map.test/?split=${split}`)).split, .5);
  const state = readState(new URL('https://map.test/?split=99#25/200/500'));
  assert.equal(state.split, .88); assert.equal(state.zoom, 18); assert.equal(state.center[0], 85); assert.equal(state.center[1], 140);
});

test('shared dates, magnification and comparison mode survive parsing unchanged', () => {
  const state = readState(new URL('https://map.test/?left=landsat%3Aexample&right=WB_2020_R01&visualZoom=250&mode=separate&slider=0#14/49.5/25.3'));
  assert.equal(state.left, 'landsat:example'); assert.equal(state.right, 'WB_2020_R01');
  assert.equal(state.magnify, true); assert.equal(state.visualZoom, 250); assert.equal(state.separate, true); assert.equal(state.hideSlider, true);
});

test('a date occurs once, with the most detailed source chosen automatically', () => {
  const choices = dateChoices([layer('l','2026-10-01','landsat'), layer('e','2026-10-01'), layer('old','1984-04-07','landsat')]);
  assert.deepEqual(choices.map(x => x.id), ['e','old']);
});

test('same-day satellite scenes prefer lower scene cloud cover', () => {
  const choices = dateChoices([layer('cloudy','2026-10-01','landsat',{cloud:29}),layer('clear','2026-10-01','landsat',{cloud:2})]);
  assert.equal(choices[0].id, 'clear');
});

test('an exact shared scene survives same-day automatic source preference', () => {
  const choices = dateChoices([layer('e','2026-10-01'), layer('s','2026-10-01','landsat')], 's');
  assert.equal(selectLayer(choices,{id:'s',mode:'manual'}).id,'s');
});

test('manual date selected during a refresh remains selected after merging', () => {
  const before = [layer('old','1984-04-07','landsat'), layer('middle','2019-01-01'),layer('new','2026-01-01')];
  let selected = 'old';
  const incoming = [...before,layer('newest','2026-10-29')];
  selected = 'middle';
  assert.equal(selectLayer(dateChoices(incoming, selected), {id:selected,mode:'manual'}).id,'middle');
  assert.equal(selectLayer(dateChoices(incoming),{mode:'oldest'}).id,'old');
  assert.equal(selectLayer(dateChoices(incoming),{mode:'newest'}).id,'newest');
});

test('moving outside a scene preserves the comparison period with the nearest date', () => {
  const choices = dateChoices([layer('new','2026-10-29'),layer('old','1985-06-01','landsat')]);
  assert.equal(selectLayer(choices,{id:'old-place',mode:'manual',date:'1984-04-07'}).id,'old');
});

test('a slow historical provider restores the requested period after provisional dates', () => {
  const intent = {id:'old-place',mode:'manual',date:'1984-04-07'};
  const esri = [layer('modern','2026-10-29'),layer('esri-old','2014-02-20')];
  assert.equal(selectLayer(dateChoices(esri),intent).id,'esri-old');
  const complete = [...esri,layer('historical','1985-05-01','landsat')];
  assert.equal(selectLayer(dateChoices(complete),intent).id,'historical');
});

test('returning to a cached place invalidates a request for the intervening place', () => {
  const requests = new LatestRequest();
  const a = requests.begin('A');
  const b = requests.begin('B');
  const cachedA = requests.begin('A');
  assert.equal(a.signal.aborted,true); assert.equal(b.signal.aborted,true);
  assert.equal(requests.isCurrent(b),false); assert.equal(requests.isCurrent(cachedA),true);
});

test('scene coverage uses footprints, not just rectangular bounds', () => {
  const item=sceneLayer(scene('test','2026-01-01'));
  assert.equal(coversPoint(item,{lat:50,lng:30}),true);
  assert.equal(coversPoint(item,{lat:48,lng:30}),false);
  item.geometry.coordinates.push([[29.5,49.5],[30.5,49.5],[30.5,50.5],[29.5,50.5],[29.5,49.5]]);
  assert.equal(coversPoint(item,{lat:50,lng:30}),false);
});

test('tile coordinates stay valid at the world edges', () => {
  for (const lat of [-90,90]) for (const lng of [-540,180,540]) {
    const {row,column,level}=tileCoordinates({lat,lng},18);
    assert.ok(row >= 0 && row < 2**level); assert.ok(column >= 0 && column < 2**level);
  }
});

test('catalog pagination includes the oldest dates and removes duplicate scenes', async () => {
  let count=0;
  const latest=scene('latest','2026-10-01'), oldest=scene('oldest','1984-04-07');
  const result=await loadScenes('landsat',{lat:50.45,lng:30.52},undefined, async url => {
    count++;
    if(count===1) {
      const parsed=new URL(url); assert.equal(parsed.searchParams.get('collections'),'landsat-c2-l2');
      const [west,south,east,north]=parsed.searchParams.get('bbox').split(',').map(Number);
      assert.ok(west<=30.52 && east>=30.52 && south<=50.45 && north>=50.45);
      assert.equal(JSON.parse(parsed.searchParams.get('query'))['eo:cloud_cover'].lte,30);
      return response({features:[latest],links:[{rel:'next',method:'GET',href:'https://planetarycomputer.microsoft.com/api/stac/v1/search?token=next'}]});
    }
    return response({features:[latest,oldest],links:[]});
  });
  assert.equal(count,2); assert.deepEqual(result.map(x=>x.date),['2026-10-01','1984-04-07']);
});

test('failed later pages do not pretend to be a complete satellite archive', async () => {
  let count=0;
  await assert.rejects(loadScenes('landsat',{lat:50,lng:30},undefined,async () => ++count===1
    ? response({features:[scene('latest','2026-10-01')],links:[{rel:'next',href:'https://planetarycomputer.microsoft.com/api/stac/v1/search?token=next'}]})
    : {ok:false,status:503}), /503/);
});

test('shared satellite scenes resolve by ID independently of catalog pagination', async () => {
  const item=await loadSceneById('landsat:oldest',undefined,async url => {
    assert.ok(url.endsWith('/landsat-c2-l2/items/oldest')); return response(scene('oldest','1984-04-07'));
  });
  assert.equal(item.id,'landsat:oldest');
  assert.equal(await loadSceneById('sentinel:../../secret'),null);
});

test('timeouts terminate stalled provider requests', async () => {
  await assert.rejects(fetchJson('https://example.test',undefined,(_url,{signal}) => new Promise((_resolve,reject) => {
    signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')));
  }),5), /вчасно/);
});

test('Esri local changes follow release chronology and skip unchanged snapshots', async () => {
  const layers=[layer('new','2026-01-01','esri',{releaseNum:77}),layer('changed','2020-01-01','esri',{releaseNum:4}),layer('old','2014-01-01','esri',{releaseNum:15})];
  let calls=0;
  const result=await localWayback(layers,{lat:50,lng:30},12,undefined,async url => {
    calls++;
    if(calls===1) { assert.ok(url.includes('/77/')); return response({data:[1],select:[4]}); }
    assert.ok(url.includes('/15/')); return response({data:[1],select:[15]});
  });
  assert.deepEqual(result.map(x=>x.id),['changed','old']);
});

test('fallback archive includes old shared dates and the latest verified release', () => {
  assert.ok(fallbackLayers.length > 190);
  assert.equal(fallbackLayers[0].date,'2026-10-29');
  assert.equal(fallbackLayers.at(-1).date,'2014-02-20');
  assert.ok(fallbackLayers.every(x=>x.source==='esri' && x.template.includes('{z}/{y}/{x}')));
});

test('providers are inferred from old links and can be explicitly selected', () => {
  const oldLink = readState(new URL('https://map.test/?left=landsat%3Aold&right=WB_2020_R01'));
  assert.equal(oldLink.leftProvider,'landsat'); assert.equal(oldLink.rightProvider,'esri');
  const explicit = readState(new URL('https://map.test/?left=landsat%3Aold&leftProvider=esri&rightProvider=invalid'));
  assert.equal(explicit.leftProvider,'esri'); assert.equal(explicit.rightProvider,'esri');
  assert.equal(providerForId('WB_2026_R10'),'esri');
});

test('provider date lists do not mix scenes or fall back to another provider', () => {
  const scenes=[layer('esri','2026-10-01'),layer('landsat','2026-10-01','landsat'),layer('old','1984-04-07','landsat')];
  assert.deepEqual(providerChoices(scenes,'landsat').map(x=>x.id),['landsat','old']);
  assert.deepEqual(providerChoices(scenes.slice(0,1),'landsat'),[]);
});

test('year and month filters contain only genuinely available dates', () => {
  const dates=[layer('dec','2026-12-01'),layer('jan','2026-01-10'),layer('old','2025-01-10')];
  assert.deepEqual(filterDates(dates,'2026').map(x=>x.id),['dec','jan']);
  assert.deepEqual(filterDates(dates,'2026','01').map(x=>x.id),['jan']);
  assert.deepEqual(filterDates(dates,'2026','02'),[]);
  assert.deepEqual(filterDates(dates,'all','01').map(x=>x.id),['jan','old']);
});

test('chronological arrows skip gaps and cross month and year boundaries', () => {
  const dates=[layer('new','2026-01-05'),layer('middle','2025-12-20'),layer('old','2025-04-01')];
  assert.equal(adjacentLayer(dates,'middle','older').id,'old');
  assert.equal(adjacentLayer(dates,'middle','newer').id,'new');
  assert.equal(adjacentLayer(dates,'old','newer').id,'middle');
});

test('arrows stop at the first and last date instead of wrapping', () => {
  const dates=[layer('new','2026-01-05'),layer('old','2025-04-01')];
  assert.equal(adjacentLayer(dates,'old','older'),null);
  assert.equal(adjacentLayer(dates,'new','newer'),null);
  assert.equal(adjacentLayer([],null,'newer'),null);
});

test('single mode survives URL restoration and remembers the comparison layout', () => {
  const state=readState(new URL('https://map.test/?mode=single&comparison=separate&leftProvider=landsat&rightProvider=esri'));
  assert.equal(state.single,true); assert.equal(state.separate,true);
  assert.equal(state.leftProvider,'landsat'); assert.equal(state.rightProvider,'esri');
  assert.equal(readState(new URL('https://map.test/?mode=split')).single,false);
});

test('single mode uses the full canvas and gives the second map no visible area', () => {
  assert.deepEqual(layoutSizes(1280,.25,true,true),{left:1280,right:0,separate:false});
  assert.deepEqual(layoutSizes(1280,.25,true,false),{left:640,right:640,separate:true});
  assert.deepEqual(layoutSizes(1280,.25,false,false),{left:320,right:960,separate:false});
});

test('Sentinel-2 links restore the shared fresh scene and provider', () => {
  assert.equal(SOURCES.sentinel.name, 'Sentinel-2');
  assert.equal(providerForId('sentinel:S2C_MSIL2A_20261115'), 'sentinel');
  const state = readState(new URL('https://map.test/?left=sentinel%3AS2C_old&right=landsat%3Avalid#17/50.45/30.52'));
  assert.equal(state.leftProvider, 'sentinel'); assert.equal(state.left, 'sentinel:S2C_old');
  assert.equal(state.rightProvider, 'landsat'); assert.equal(state.right, 'landsat:valid');
  const explicit = readState(new URL('https://map.test/?leftProvider=sentinel&rightProvider=sentinel'));
  assert.equal(explicit.leftProvider, 'sentinel'); assert.equal(explicit.rightProvider, 'sentinel');
});

test('Sentinel-2 scenes come from Planetary Computer at 10 m and z14', async () => {
  const center = { lat: 50.45, lng: 30.52 };
  const layers = await loadScenes('sentinel', center, undefined, async url => {
    assert.equal(new URL(url).searchParams.get('collections'), 'sentinel-2-l2a');
    return response({ features: [scene('S2C_MSIL2A_20261115', '2026-11-15', 'sentinel-2-l2a')], links: [] });
  });
  assert.equal(layers.length, 1);
  assert.equal(layers[0].id, 'sentinel:S2C_MSIL2A_20261115');
  assert.equal(layers[0].source, 'sentinel');
  assert.equal(layers[0].resolution, 10);
  const item = await loadSceneById('sentinel:S2B_one', undefined, async url => {
    assert.ok(url.endsWith('/sentinel-2-l2a/items/S2B_one'));
    return response(scene('S2B_one', '2026-11-07', 'sentinel-2-l2a'));
  });
  assert.equal(item.id, 'sentinel:S2B_one');
  assert.equal(await loadSceneById('sentinel:../../secret'), null);
  const definition = await tileDefinition(layers[0], undefined, async () => response({ tiles: ['https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?collection=sentinel-2-l2a'] }));
  assert.equal(definition.nativeZoom, 14);
});
