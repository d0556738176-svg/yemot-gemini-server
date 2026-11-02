import test from 'node:test';
import assert from 'node:assert/strict';
import {createApifyResolver} from './youtube-apify-source.js';
import {pickApifyActor} from './youtube-engine-select.js';
const id='9scnWAgV6us';
test('native routing avoids duration lookup and paid fallback',async()=>{
 const r=await pickApifyActor(id,{},()=>{throw Error('unexpected lookup');});
 assert.equal(r.actor,'johnvc/youtube-download-api');assert.equal(r.fallback,null);
});
for(const valid of [true,false])test('native result '+(valid?'resumes without new run':'rejects missing integrity'),async()=>{
 let receipt=null,starts=0;
 const store={read:async()=>receipt,write:async(_,v)=>{receipt=v;}};
 const fetchImpl=async(url,opts={})=>{
  if(opts.method==='POST'){
   starts++;const b=JSON.parse(opts.body);assert.equal(b.format,'audio');assert.equal(b.audioQuality,'high');assert.equal(b.audioFormat,'m4a');assert.match(url,/maxTotalChargeUsd=0.01/);
   return Response.json({data:{id:'SavedRun123'}});
  }
  if(url.includes('/actor-runs/'))return Response.json({data:{status:'SUCCEEDED',defaultDatasetId:'Dataset123'}});
  if(url.includes('/datasets/'))return Response.json([{resultType:'file',videoId:id,durationSeconds:3595,fileSizeBytes:21880280,sha256:valid?'a'.repeat(64):null,fileUrl:'https://api.apify.com/v2/key-value-stores/store/records/audio?signature=signed'}]);
  throw Error('unexpected route');
 };
 const resolver=createApifyResolver({fetchImpl,log:{info(){}}});
 const env={APIFY_TOKEN:'test-only'};
 const opts={actor:'johnvc/youtube-download-api',store};
 if(!valid){await assert.rejects(resolver(id,env,opts),{code:'apify_invalid_result'});return;}
 const result=await resolver(id,env,opts);assert.equal(new URL(result.url).searchParams.has('token'),false);
 await resolver(id,env,opts);assert.equal(starts,1);
});
