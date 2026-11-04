import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {classifyProviderTerminal,createApifyResolver,apifyReceiptPath} from './youtube-apify-source.js';

test('actual slow-route evidence outranks misleading blocked summary and incidental SSL',()=>{
 assert.equal(classifyProviderTerminal({status:'FAILED',statusMessage:'1 blocked on our side'},[
  'ERROR SSL: WRONG_VERSION_NUMBER','download too slow to finish in time','download stalled under 50KiB/s'
 ]),'apify_provider_slow');
 assert.equal(classifyProviderTerminal({status:'FAILED'},['download stalled','Sign in to confirm you are not a bot']),'apify_provider_blocked');
});
test('the observed slow failure stays terminal across repeated callbacks and restarts',async()=>{
 const id='EF8C4v7JIbA';let posts=0;
 const records=new Map([[apifyReceiptPath(id),{version:1,videoId:id,actorId:'memo23~youtube-video-downloader',runId:'savedRun',attemptCount:1,createdAt:'2026-11-02T11:09:00Z'}]]);
 const store={read:async p=>records.get(p),write:async(p,v)=>records.set(p,v)};
 for(let i=0;i<3;i++){
  const resolve=createApifyResolver({now:()=>Date.parse('2026-11-03T12:00:00Z'),log:{info(){},warn(){}},fetchImpl:async(u,o)=>{
   if(o.method==='POST'){posts++;assert.fail('must not charge for another slow retry');}
   if(u.endsWith('/log'))return new Response('ERROR download too slow to finish in time\nERROR download stalled');
   return Response.json({data:{status:'FAILED',statusMessage:'1 blocked on our side'}});
  }});
  await assert.rejects(resolve(id,{APIFY_TOKEN:'fixture'},{store,actor:'memo23/youtube-video-downloader'}),e=>e.code==='apify_provider_slow');
 }
 assert.equal(posts,0);assert.equal(records.get(apifyReceiptPath(id)).runId,'savedRun');
});
test('actual webhook handler accepts every terminal event and rejects bad auth or nonterminal events',async()=>{
 const source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
 const start=source.indexOf("app.post('/apify-webhook'");const end=source.indexOf('\n\napp.use(router)',start);
 let handler;const resumed=[];let pending=true;
 vm.runInNewContext(source.slice(start,end),{app:{post:(p,h)=>handler=h},process:{env:{BRANCH2_WEBHOOK_SECRET:'fixture'}},console:{info(){},warn(){}},
  startYouTubePlaybackJob:v=>resumed.push(v),webhookShouldResume:async()=>pending});
 const invoke=async(eventType,secret='fixture')=>{
  let code;await handler({query:{videoId:'EF8C4v7JIbA',secret},body:{eventType}},{status:c=>{code=c;return {json(){}};}});return code;
 };
 for(const event of ['ACTOR.RUN.SUCCEEDED','ACTOR.RUN.FAILED','ACTOR.RUN.ABORTED','ACTOR.RUN.TIMED_OUT'])assert.equal(await invoke(event),200);
 assert.equal(resumed.length,4);assert.ok(resumed.every(v=>v.videoId==='EF8C4v7JIbA'&&!v.consentToFallback));
 assert.equal(await invoke('ACTOR.RUN.CREATED'),400);assert.equal(await invoke('ACTOR.RUN.SUCCEEDED','bad'),403);assert.equal(resumed.length,4);
 // A video with nothing pending (final answer already given, or already saved) is not restarted.
 pending=false;assert.equal(await invoke('ACTOR.RUN.SUCCEEDED'),200);assert.equal(resumed.length,4);
});
test('actual phone message distinguishes a supplier stall from bot rejection',async()=>{
 const source=await fs.readFile(new URL('./youtube-playback-prepare.js',import.meta.url),'utf8');
 const begin=source.indexOf('export function playbackFailureMessage(');
 const fn=vm.runInNewContext(source.slice(begin).replace('export function','function')+';playbackFailureMessage',{YOUTUBE_REFUSAL_CODES:new Set()});
 assert.match(fn('apify_provider_slow'),/קצב הורדה נמוך/);assert.match(fn('apify_provider_slow'),/לא התקבל קובץ מלא/);
 assert.doesNotMatch(fn('apify_provider_slow'),/נחסם על ידי יוטיוב/);
});
