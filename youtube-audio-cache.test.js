import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioCache,audioCachePaths,audioManifestPath,verifiedAudioFile} from './youtube-audio-cache.js';
import {prepareYouTubePlayback} from './youtube-playback-prepare.js';
const id='0D2MvNWOVk0',paths=audioCachePaths(id,4);
const ready={responseStatus:'OK',file:{exists:true,size:1920078}};
const quiet={info(){},warn(){}};
function storage(){
 const files=new Map(), manifests=new Map();
 const deps={getFile:async p=>files.get(p),readJson:async p=>manifests.get(p)||null,writeJson:async(p,m)=>manifests.set(p,structuredClone(m)),log:quiet};
 return {files,manifests,deps,cache:createAudioCache(deps)};
}
test('persist full verified audio and replay after a fresh cache instance',async()=>{
 const s=storage();for(const p of paths)s.files.set('ivr2:'+p+'.wav',ready);
 await s.cache.save(id,paths);
 const fresh=createAudioCache(s.deps);
 assert.deepEqual((await fresh.lookup(id)).playbackPaths,paths);
});
test('cache hit calls neither worker, alternate resolver nor downloader',async()=>{
 let count=0;
 const result=await prepareYouTubePlayback({videoId:id},{env:{YOUTUBE_AUDIO_WORKER_URL:'https://worker.invalid',YOUTUBE_AUDIO_WORKER_SECRET:'test'},lookupCached:async()=>({playbackPaths:paths}),fetchImpl:async()=>{count++;assert.fail();},resolveAlternate:async()=>assert.fail(),downloadToYemot:async()=>assert.fail(),log:quiet});
 assert.equal(result.via,'cache');assert.equal(count,0);
});
test('partial upload cannot publish completion',async()=>{
 const s=storage();for(const p of paths.slice(0,3))s.files.set('ivr2:'+p+'.wav',ready);
 await assert.rejects(s.cache.save(id,paths),e=>e.code==='cache_incomplete');
 assert.equal(s.manifests.size,0);
});
test('deleted chunk prevents replay and never triggers billable fallback',async()=>{
 const s=storage();for(const p of paths)s.files.set('ivr2:'+p+'.wav',ready);
 await s.cache.save(id,paths);s.files.delete('ivr2:'+paths[2]+'.wav');
 await assert.rejects(prepareYouTubePlayback({videoId:id},{lookupCached:()=>s.cache.lookup(id),downloadToYemot:async()=>assert.fail('must not spend a credit'),log:quiet}),e=>e.code==='cache_incomplete');
});
test('cache service failure never triggers download',async()=>{
 await assert.rejects(prepareYouTubePlayback({videoId:id},{lookupCached:async()=>{throw Error('storage down');},downloadToYemot:async()=>assert.fail(),log:quiet}),/storage down/);
});
test('missing manifest allows first download',async()=>{
 const s=storage();let calls=0;
 const result=await prepareYouTubePlayback({videoId:id},{env:{},lookupCached:()=>s.cache.lookup(id),downloadToYemot:async()=>{calls++;return {playbackPaths:paths};},log:quiet});
 assert.equal(result.via,'direct');assert.equal(calls,1);
});
test('wrong identity, unsafe path, duplicate path, incomplete and mismatched receipts rejected',async()=>{
 for(const override of [{videoId:'different'},{complete:false},{playbackPaths:['/2/bad-path']},{chunkCount:5},{playbackPaths:[paths[0],paths[0],paths[2],paths[3]]}]){
  const s=storage();s.manifests.set(audioManifestPath(id),{version:1,videoId:id,complete:true,chunkCount:4,playbackPaths:paths,...override});
  await assert.rejects(s.cache.lookup(id),e=>e.code==='cache_invalid');
 }
});
test('metadata must explicitly confirm existence and finite nonempty bytes',()=>{
 for(const data of [{responseStatus:'OK'},{...ready,file:{exists:true}},{...ready,file:{exists:true,size:44}},{...ready,file:{exists:false,size:999}},{...ready,file:{exists:true,size:'NaN'}}])assert.equal(verifiedAudioFile(data),false);
 assert.equal(verifiedAudioFile(ready),true);
});
test('worker success saved for later replay before result returned',async()=>{
 let saved=0;
 const r=await prepareYouTubePlayback({videoId:id},{env:{YOUTUBE_AUDIO_WORKER_URL:'https://worker.invalid',YOUTUBE_AUDIO_WORKER_SECRET:'test'},fetchImpl:async()=>({ok:true,status:200,json:async()=>({status:'ready',playbackPaths:paths})}),saveCached:async(gotId,gotPaths)=>{assert.equal(gotId,id);assert.deepEqual(gotPaths,paths);saved++;},downloadToYemot:async()=>assert.fail(),log:quiet});
 assert.equal(r.via,'worker');assert.equal(saved,1);
});

test('receipt write failure after worker success never causes a second download',async()=>{
 await assert.rejects(prepareYouTubePlayback({videoId:id},{env:{YOUTUBE_AUDIO_WORKER_URL:'https://worker.invalid',YOUTUBE_AUDIO_WORKER_SECRET:'test'},fetchImpl:async()=>({ok:true,status:200,json:async()=>({status:'ready',playbackPaths:paths})}),saveCached:async()=>{throw Object.assign(new Error('storage failed'),{code:'cache_write_failed'});},downloadToYemot:async()=>assert.fail('second paid download'),log:quiet}),e=>e.code==='cache_write_failed');
});
