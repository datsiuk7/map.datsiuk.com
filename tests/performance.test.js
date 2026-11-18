import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceCache, delay, frameTask } from '../assets/performance.js';
import { sceneArea } from '../assets/catalog.js';
import { catalogKey } from '../assets/providers.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a,b) => { resolve=a; reject=b; });
  return { promise, resolve, reject };
};
const memoryStore = () => {
  const data=new Map();
  return { get:async key=>data.get(key), put:async(key,value)=>data.set(key,value), delete:async key=>data.delete(key) };
};

test('simultaneous catalog consumers and repeat visits share a single request', async () => {
  const cache=new ResourceCache(); const pending=deferred(); let calls=0;
  const loader=()=>{ calls++; return pending.promise; };
  const first=cache.get('same-cell',loader), second=cache.get('same-cell',loader);
  pending.resolve(['one','two']);
  assert.deepEqual(await first,await second);
  assert.deepEqual(await cache.get('same-cell',loader),['one','two']);
  assert.equal(calls,1);
});

test('a reload can reuse the persisted catalog without fetching the archive', async () => {
  const store=memoryStore(); let calls=0;
  const loader=async()=>{ calls++; return ['oldest','newest']; };
  await new ResourceCache({storage:store}).get('area',loader);
  const afterReload=await new ResourceCache({storage:store}).get('area',loader);
  assert.deepEqual(afterReload,['oldest','newest']); assert.equal(calls,1);
});

test('expiry and an explicit retry refresh cached data', async () => {
  let clock=100, calls=0;
  const cache=new ResourceCache({ttl:10,now:()=>clock,storage:memoryStore()});
  const loader=async()=>++calls;
  assert.equal(await cache.get('x',loader),1);
  clock=109; assert.equal(await cache.get('x',loader),1);
  clock=111; assert.equal(await cache.get('x',loader),2);
  assert.equal(await cache.get('x',loader,{force:true}),3);
});

test('memory cache evicts least-recently-used areas at its fixed bound', async () => {
  const cache=new ResourceCache({maxEntries:2});
  await cache.get('a',async()=>1); await cache.get('b',async()=>2);
  await cache.get('a',async()=>99); await cache.get('c',async()=>3);
  assert.deepEqual([...cache.entries.keys()],['a','c']);
});

test('cancelling one consumer does not abort another consumer of the same metadata', async () => {
  const cache=new ResourceCache(), pending=deferred();
  const firstController=new AbortController(), secondController=new AbortController();
  let requestSignal;
  const loader=signal=>{ requestSignal=signal; return pending.promise; };
  const first=cache.get('shared',loader,{signal:firstController.signal});
  const rejected=assert.rejects(first,{name:'AbortError'});
  const second=cache.get('shared',loader,{signal:secondController.signal});
  await Promise.resolve();
  firstController.abort(); await rejected;
  assert.equal(requestSignal.aborted,false);
  pending.resolve('ready'); assert.equal(await second,'ready');
});

test('cancelling the last consumer aborts the network request and permits a fresh request', async () => {
  const cache=new ResourceCache(), controller=new AbortController();
  let requestSignal;
  const first=cache.get('aborted',signal=>new Promise((_resolve,reject)=>{
    requestSignal=signal;
    signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')));
  }),{signal:controller.signal});
  const rejected=assert.rejects(first,{name:'AbortError'});
  await Promise.resolve(); controller.abort(); await rejected;
  assert.equal(requestSignal.aborted,true);
  assert.equal(await cache.get('aborted',async()=>42),42);
});

test('a failed fetch is not retained in the cache', async () => {
  const cache=new ResourceCache();
  await assert.rejects(cache.get('failure',async()=>{throw new Error('offline');}),/offline/);
  assert.equal(await cache.get('failure',async()=>'recovered'),'recovered');
});

test('unavailable browser storage does not prevent normal loading', async () => {
  const cache=new ResourceCache({storage:{get:async()=>{throw new Error('blocked');},put:async()=>{throw new Error('quota');}}});
  assert.equal(await cache.get('x',async()=>23),23);
});

test('frame tasks collapse a burst of divider events to the newest position', () => {
  const frames=[], drawn=[];
  const draw=frameTask(value=>drawn.push(value),callback=>{frames.push(callback);return frames.length;});
  for(let i=0;i<100;i++) draw(i);
  assert.equal(frames.length,1);
  frames[0](); assert.deepEqual(drawn,[99]);
  draw(100); assert.equal(frames.length,2);
});

test('rapid date switching cancels the wait for a superseded frame', async () => {
  const controller=new AbortController();
  const waiting=assert.rejects(delay(1000,controller.signal),{name:'AbortError'});
  controller.abort(); await waiting;
});

test('nearby pans share one complete query cell and satellite zoom does not change the key', () => {
  const area=sceneArea({lat:50.45,lng:30.52});
  const [west,south,east,north]=area.bounds;
  const center={lat:(south+north)/2,lng:(west+east)/2};
  const neighbor={lat:center.lat+.0001,lng:center.lng+.0001};
  assert.equal(catalogKey('landsat',center,12),catalogKey('landsat',neighbor,18));
  assert.ok(west<=center.lng && center.lng<=east && south<=center.lat && center.lat<=north);
  assert.notEqual(catalogKey('landsat',center,12),catalogKey('landsat',{...center,lng:east+.0001},12));
});
