import test from 'node:test';
import assert from 'node:assert/strict';
import {createApifyResolver,apifyReceiptPath} from './youtube-apify-source.js';
const id='abcdefghijk',env={APIFY_TOKEN:'fixture',BRANCH2_APIFY_ACTOR:'memo23/youtube-video-downloader'},quiet={info(){}};
function fixture(){
 let clock=0,posts=0,gets=0,status='RUNNING';
 const records=new Map();
 const store={read:async p=>records.get(p)||null,write:async(p,v)=>records.set(p,structuredClone(v))};
 const output={videoId:id,format:'mp3',downloadUrl:'https://api.apify.com/v2/key-value-stores/kv1/records/audio.mp3',durationSec:1800};
 const fetchImpl=async(url,opts)=>{
  if(opts.method==='POST'){posts++;assert.equal(records.get(apifyReceiptPath(id))?.state,'starting');assert.equal(JSON.parse(opts.body).format,'mp3');assert.ok(url.includes('restartOnError=false'));assert.ok(url.includes('maxTotalChargeUsd=0.06'));return Response.json({data:{id:'run1'}});}
  gets++;if(url.includes('/actor-runs/'))return Response.json({data:{status,defaultDatasetId:'dataset1'}});
  if(url.includes('/datasets/'))return Response.json([output]);
  throw Error('unexpected request');
 };
 const make=()=>createApifyResolver({fetchImpl,now:()=>clock,sleep:async ms=>{clock+=ms;},log:quiet});
 return {store,records,output,make,fetchImpl,setStatus:v=>status=v,posts:()=>posts,gets:()=>gets};
}
test('run longer than old 180 second limit succeeds with one POST',async()=>{
 const f=fixture();let polls=0;
 const resolver=createApifyResolver({fetchImpl:async(u,o)=>{if(u.includes('/actor-runs/')&&++polls>40)f.setStatus('SUCCEEDED');return f.fetchImpl(u,o);},sleep:async()=>{},log:quiet});
 const r=await resolver(id,env,{store:f.store});assert.equal(r.durationSeconds,1800);assert.equal(f.posts(),1);assert.equal(polls,41);
});
test('local wait expires then new process resumes the same run without POST',async()=>{
 const f=fixture();
 await assert.rejects(f.make()(id,{...env,BRANCH2_APIFY_WAIT_MS:1000},{store:f.store}),e=>e.code==='apify_pending');
 f.setStatus('SUCCEEDED');const r=await f.make()(id,env,{store:f.store});
 assert.equal(r.runId,'run1');assert.equal(f.posts(),1);
});
test('completed run reuses its file after fresh resolver',async()=>{
 const f=fixture();f.setStatus('SUCCEEDED');
 await f.make()(id,env,{store:f.store});await f.make()(id,env,{store:f.store});assert.equal(f.posts(),1);
});
test('parallel callers share a single run and result',async()=>{
 const f=fixture();f.setStatus('SUCCEEDED');const resolver=f.make();
 const results=await Promise.all([resolver(id,env,{store:f.store}),resolver(id,env,{store:f.store})]);assert.equal(results[0].runId,results[1].runId);assert.equal(f.posts(),1);
});
test('unknown POST acknowledgement blocks every later POST after restart',async()=>{
 const f=fixture();const resolver=createApifyResolver({fetchImpl:async()=>{throw Error('connection lost');},log:quiet});
 await assert.rejects(resolver(id,env,{store:f.store}),e=>e.code==='apify_start_uncertain');
 await assert.rejects(f.make()(id,env,{store:f.store}),e=>e.code==='apify_start_uncertain');assert.equal(f.posts(),0);
});
test('cannot create a run before intent is durably stored',async()=>{
 const f=fixture();await assert.rejects(f.make()(id,env,{store:{read:async()=>null,write:async()=>{throw Error('storage down');}}}),/storage down/);assert.equal(f.posts(),0);
});
test('terminal provider failure is not rerun on repeat selection',async()=>{
 const f=fixture();f.setStatus('TIMED-OUT');
 for(let i=0;i<2;i++)await assert.rejects(f.make()(id,env,{store:f.store}),e=>e.code==='apify_run_failed');assert.equal(f.posts(),1);
});
test('temporary GET failure retains durable run and does not create a new one',async()=>{
 const f=fixture();f.records.set(apifyReceiptPath(id),{version:1,videoId:id,actorId:'memo23~youtube-video-downloader',runId:'run1'});
 const resolver=createApifyResolver({fetchImpl:async()=>new Response('',{status:502}),log:quiet});
 await assert.rejects(resolver(id,env,{store:f.store}),e=>e.code==='apify_pending');
 f.setStatus('SUCCEEDED');await f.make()(id,env,{store:f.store});assert.equal(f.posts(),0);
});
test('source watch URL is never mistaken for downloaded audio',async()=>{
 const f=fixture();f.setStatus('SUCCEEDED');f.output.downloadUrl=null;f.output.url='https://www.youtube.com/watch?v='+id;
 await assert.rejects(f.make()(id,env,{store:f.store}),e=>e.code==='apify_no_file');
});
test('wrong video returned by dataset is rejected',async()=>{
 const f=fixture();f.setStatus('SUCCEEDED');f.output.videoId='wrongVideoID';
 await assert.rejects(f.make()(id,env,{store:f.store}),e=>e.code==='apify_invalid_result');
});
test('legacy timed-out video is recovered with GET requests only',async()=>{
 const legacy='Nb9xE8J6pgA',records=new Map();let posts=0;
 const store={read:async p=>records.get(p)||null,write:async(p,r)=>records.set(p,r)};
 const resolve=createApifyResolver({log:quiet,fetchImpl:async(u,o)=>{
  if(o.method==='POST'){posts++;assert.fail('legacy must never start');}
  if(u.includes('/acts/'))return Response.json({data:{items:[{id:'oldRun',defaultKeyValueStoreId:'oldKV'}]}});
  if(u.includes('/records/INPUT'))return Response.json({videoUrls:['https://www.youtube.com/watch?v='+legacy],format:'mp3'});
  if(u.includes('/actor-runs/'))return Response.json({data:{status:'SUCCEEDED',defaultDatasetId:'oldDataset'}});
  return Response.json([{videoId:legacy,downloadUrl:'https://example.com/audio.mp3'}]);
 }});
 assert.equal((await resolve(legacy,env,{store})).runId,'oldRun');assert.equal(posts,0);
});
test('missing legacy history blocks a second paid attempt',async()=>{
 const resolve=createApifyResolver({log:quiet,fetchImpl:async(u,o)=>{assert.equal(o.method,'GET');return Response.json({data:{items:[]}});}});
 await assert.rejects(resolve('Nb9xE8J6pgA',env,{store:{read:async()=>null,write:async()=>assert.fail()}}),e=>e.code==='apify_start_uncertain');
});
