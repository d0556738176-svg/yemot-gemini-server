import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createPlaybackAwake} from './playback-awake.js';

function fixture(extra={}){
 let tick,pings=0,started=0,stopped=0,interval;
 const awake=createPlaybackAwake({env:{RENDER_EXTERNAL_URL:'https://fixture.invalid',...extra},
  fetchImpl:async u=>{assert.equal(u,'https://fixture.invalid/health');pings++;return new Response('ok');},
  setIntervalImpl:(fn,ms)=>{tick=fn;interval=ms;started++;return {unref(){}};},
  clearIntervalImpl:()=>{stopped++;tick=null;},log:{info(){},warn(){}}});
 return {awake,tick:()=>tick?.(),pings:()=>pings,started:()=>started,stopped:()=>stopped,interval:()=>interval};
}
const flush=()=>new Promise(r=>setImmediate(r));
test('three-hour preparation keeps inbound requests below idle threshold, then stops',async()=>{
 const f=fixture(),release=f.awake.acquire();await flush();assert.equal(f.pings(),1);
 for(let minute=2;minute<=180;minute+=2){f.tick();await flush();}
 assert.equal(f.pings(),91);assert.equal(f.interval(),120000);
 release();release();f.tick();await flush();
 assert.equal(f.awake.activeCount(),0);assert.equal(f.stopped(),1);assert.equal(f.pings(),91);
});
test('parallel preparations share one timer and one finished job cannot stop the other',async()=>{
 const f=fixture(),a=f.awake.acquire(),b=f.awake.acquire();await flush();
 assert.equal(f.started(),1);assert.equal(f.awake.activeCount(),2);
 a();assert.equal(f.stopped(),0);f.tick();await flush();assert.equal(f.pings(),2);
 b();assert.equal(f.stopped(),1);
});
test('bad interval cannot exceed five minutes and opt-out or missing host sends nothing',async()=>{
 for(const value of ['3600000','bad','0','-1']){
  const f=fixture({BRANCH2_KEEPALIVE_MS:value}),release=f.awake.acquire();
  assert.ok(f.interval()<=300000);release();
 }
 const f=fixture({BRANCH2_KEEPALIVE:'off'});f.awake.acquire()();await flush();assert.equal(f.pings(),0);
});
test('overlapping slow requests are prevented and failures recover on next tick',async()=>{
 let resolve,tick,requests=0,warnings=0;
 const awake=createPlaybackAwake({env:{RENDER_EXTERNAL_URL:'https://fixture.invalid'},
  fetchImpl:()=>{requests++;return new Promise(r=>resolve=r);},setIntervalImpl:fn=>{tick=fn;return {};},clearIntervalImpl(){},log:{info(){},warn(){warnings++;}}});
 const release=awake.acquire();tick();tick();assert.equal(requests,1);
 resolve(new Response('',{status:503}));await flush();assert.equal(warnings,1);
 tick();assert.equal(requests,2);resolve(new Response('ok'));await flush();release();
});
test('production pipeline owns the lease through success, failure and shared callers',async()=>{
 const source=await fs.readFile(new URL('./youtube-authorized-playback.js',import.meta.url),'utf8');
 const start=source.indexOf('export async function downloadAuthorizedAudioToYemot(');
 const end=source.indexOf('// Narrow exports',start);
 for(const fail of [false,true]){
  const f=fixture();let finish;
  const run=vm.runInNewContext(source.slice(start,end).replace('export async function','async function')+';downloadAuthorizedAudioToYemot',{
   activeJobs:new Map(),playbackAwake:f.awake,build:()=>new Promise((yes,no)=>finish=()=>fail?no(Error('fixture failure')):yes({playbackPaths:['/2/file']}))
  });
  const a=run('abcdefghijk'),b=run('abcdefghijk');await flush();assert.equal(f.awake.activeCount(),1);assert.equal(f.stopped(),0);
  finish();await Promise.allSettled([a,b]);assert.equal(f.awake.activeCount(),0);assert.equal(f.stopped(),1);
 }
});
