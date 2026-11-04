import test from 'node:test';
import assert from 'node:assert/strict';
import {createApifyResolver,apifyTokens,tokenFingerprint,classifyNativeRow,nativeLimits} from './youtube-apify-source.js';
import {pickApifyActor} from './youtube-engine-select.js';
const id='9scnWAgV6us';
const quiet={info(){},warn(){}};
const fileRow=(over={})=>({resultType:'file',videoId:id,durationSeconds:3595,fileSizeBytes:21880280,sha256:'a'.repeat(64),
  fileUrl:'https://api.apify.com/v2/key-value-stores/store/records/audio?signature=signed',...over});
const memStore=()=>{let receipt=null;return {store:{read:async()=>receipt,write:async(_,v)=>{receipt=v;}},get:()=>receipt};};

// Fake Apify: `startStatus(token)` decides the POST answer, `rowFor(runNo)` the dataset row.
function fakeApify({startStatus=()=>201,rowFor=()=>fileRow(),runStatus=()=>'SUCCEEDED'}={}){
  const calls={starts:[],polls:[]};
  const fetchImpl=async(url,opts={})=>{
    const auth=String(opts.headers?.authorization||'').replace('Bearer ','');
    if(opts.method==='POST'){
      const status=startStatus(auth);
      calls.starts.push({url,auth,body:JSON.parse(opts.body),status});
      if(status!==201)return new Response('{}',{status});
      return Response.json({data:{id:'Run'+calls.starts.length}});
    }
    const m=url.match(/actor-runs\/(Run\d+)$/);
    if(m){calls.polls.push({run:m[1],auth});return Response.json({data:{status:runStatus(Number(m[1].slice(3))),defaultDatasetId:'Ds'+m[1].slice(3)}});}
    const d=url.match(/datasets\/Ds(\d+)\//);
    if(d)return Response.json([rowFor(Number(d[1]))]);
    if(url.includes('/log'))return new Response('');
    throw Error('unexpected route '+url);
  };
  return {fetchImpl,calls};
}

test('native engine is the only engine: no backup engine is ever chosen',async()=>{
  const r=await pickApifyActor(id,{BRANCH2_NATIVE_FALLBACK_ACTOR:'memo23/youtube-video-downloader'},()=>{throw Error('unexpected lookup');});
  assert.equal(r.actor,'johnvc/youtube-download-api');
  assert.equal(r.fallback,null);
});

test('every configured key is collected, deduplicated and in priority order',()=>{
  const keys=apifyTokens({APIFY_TOKEN:'a',APIFY_TOKEN_2:'b',APIFY_TOKEN_7:'c',APIFY_TOKENS:'d, a ,e'});
  assert.deepEqual(keys,['a','b','c','d','e']);
});

test('native run uses YouTube's best m4a (high), size/length caps and a cost cap that covers the longest YouTube video',async()=>{
  const {fetchImpl,calls}=fakeApify();const {store}=memStore();
  const result=await createApifyResolver({fetchImpl,log:quiet,sleep:async()=>{}})(id,{APIFY_TOKEN:'k1'},{actor:'johnvc/youtube-download-api',store});
  const b=calls.starts[0].body;
  assert.equal(b.format,'audio');assert.equal(b.audioFormat,'m4a');assert.equal(b.audioQuality,'high');
  assert.equal(b.maxMinutes,720);assert.equal(b.maxMegabytes,768);
  const cap=Number(new URL(calls.starts[0].url,'https://x').searchParams.get('maxTotalChargeUsd'));
  assert.ok(cap>=720*0.00001,'cap must cover the longest allowed video');
  assert.equal(new URL(result.url).searchParams.has('token'),false,'signed link needs no key');
});

test('a refused key (401/402/403/429) moves the same native run to the next backup key',async()=>{
  const {fetchImpl,calls}=fakeApify({startStatus:t=>({k1:402,k2:401,k3:403,k4:429}[t]||201)});
  const {store,get}=memStore();
  const env={APIFY_TOKEN:'k1',APIFY_TOKEN_2:'k2',APIFY_TOKEN_3:'k3',APIFY_TOKEN_4:'k4',APIFY_TOKEN_5:'k5'};
  await createApifyResolver({fetchImpl,log:quiet,sleep:async()=>{}})(id,env,{actor:'johnvc/youtube-download-api',store});
  assert.deepEqual(calls.starts.map(s=>s.auth),['k1','k2','k3','k4','k5']);
  assert.ok(calls.starts.every(s=>s.url.includes('/acts/johnvc~youtube-download-api/')));
  assert.equal(get().tokenFp,tokenFingerprint('k5'));
  assert.ok(calls.polls.every(p=>p.auth==='k5'),'run is polled with the key that started it');
});

test('resume polls the owning key even after keys are re-ordered, without a new run',async()=>{
  const {fetchImpl,calls}=fakeApify({startStatus:t=>t==='k1'?402:201});
  const {store}=memStore();
  const resolver=createApifyResolver({fetchImpl,log:quiet,sleep:async()=>{}});
  await resolver(id,{APIFY_TOKEN:'k1',APIFY_TOKEN_2:'k2'},{actor:'johnvc/youtube-download-api',store});
  await resolver(id,{APIFY_TOKEN:'k2',APIFY_TOKEN_2:'k1'},{actor:'johnvc/youtube-download-api',store});
  assert.equal(calls.starts.filter(s=>s.status===201).length,1);
  assert.ok(calls.polls.every(p=>p.auth==='k2'));
});

test('all keys refusing clears the receipt and reports the precise reason',async()=>{
  for(const [statuses,code] of [[[402,402],'needs_payment'],[[402,401],'apify_accounts_unavailable']]){
    const {fetchImpl}=fakeApify({startStatus:t=>t==='k1'?statuses[0]:statuses[1]});const {store,get}=memStore();
    await assert.rejects(createApifyResolver({fetchImpl,log:quiet})(id,{APIFY_TOKEN:'k1',APIFY_TOKEN_2:'k2'},{actor:'johnvc/youtube-download-api',store}),{code});
    assert.equal(get(),null);
  }
});

test('missing integrity metadata is rejected',async()=>{
  const {fetchImpl}=fakeApify({rowFor:()=>fileRow({sha256:null})});const {store}=memStore();
  await assert.rejects(createApifyResolver({fetchImpl,log:quiet})(id,{APIFY_TOKEN:'k'},{actor:'johnvc/youtube-download-api',store}),{code:'apify_invalid_result'});
});

test('a failing native run is retried free on the native engine only, even if a backup engine is passed',async()=>{
  const {fetchImpl,calls}=fakeApify({rowFor:n=>n<=2?{resultType:'error',videoId:id,error:'DOWNLOAD_FAILED',errorMessage:'network reset'}:fileRow()});
  const {store}=memStore();
  const r=await createApifyResolver({fetchImpl,log:quiet,sleep:async()=>{}})(id,{APIFY_TOKEN:'k'},
    {actor:'johnvc/youtube-download-api',fallbackActor:'memo23/youtube-video-downloader',consentToFallback:true,store});
  assert.deepEqual(calls.starts.map(s=>s.url.match(/acts\/([^/]+)\//)[1]),Array(3).fill('johnvc~youtube-download-api'));
  assert.equal(r.actorId,'johnvc~youtube-download-api');
});

test('when free retries run out the caller gets the real reason; no other engine starts',async()=>{
  const {fetchImpl,calls}=fakeApify({rowFor:()=>({resultType:'error',videoId:id,errorMessage:'network reset'})});const {store}=memStore();
  await assert.rejects(createApifyResolver({fetchImpl,log:quiet,sleep:async()=>{}})(id,{APIFY_TOKEN:'k'},
    {actor:'johnvc/youtube-download-api',fallbackActor:'memo23/youtube-video-downloader',consentToFallback:true,store}),{code:'apify_provider_network'});
  assert.equal(calls.starts.length,3);
  assert.ok(calls.starts.every(s=>s.url.includes('johnvc~youtube-download-api')));
});

test('a resolver called without an engine uses the native engine, never an old env setting',async()=>{
  const {fetchImpl,calls}=fakeApify();const {store}=memStore();
  await createApifyResolver({fetchImpl,log:quiet,sleep:async()=>{}})(id,{APIFY_TOKEN:'k',BRANCH2_APIFY_ACTOR:'memo23/youtube-video-downloader'},{store});
  assert.ok(calls.starts[0].url.includes('johnvc~youtube-download-api'));
});

test('a private or too-long video is final: no retry and no paid backup',async()=>{
  for(const [row,code] of [[{resultType:'error',videoId:id,errorMessage:'Private video'},'youtube_unavailable'],[{resultType:'skipped',videoId:id,note:'longer than maxMinutes'},'too_large']]){
    const {fetchImpl,calls}=fakeApify({rowFor:()=>row});const {store}=memStore();
    await assert.rejects(createApifyResolver({fetchImpl,log:quiet,sleep:async()=>{}})(id,{APIFY_TOKEN:'k'},
      {actor:'johnvc/youtube-download-api',fallbackActor:'memo23/youtube-video-downloader',consentToFallback:true,store}),{code});
    assert.equal(calls.starts.length,1);
  }
});

test('row classification and limits',()=>{
  assert.equal(classifyNativeRow({resultType:'error',errorMessage:"Sign in to confirm you're not a bot"}),'apify_provider_blocked');
  assert.equal(classifyNativeRow({resultType:'error',error:'NOT_PROCESSED'}),'apify_run_failed');
  assert.deepEqual(nativeLimits({BRANCH2_NATIVE_MAX_MINUTES:'1440',BRANCH2_MAX_SOURCE_MB:'1500'}).maxMegabytes,1500);
  assert.equal(nativeLimits({BRANCH2_NATIVE_MAX_MINUTES:'1440'}).maxMinutes,720,'never above the engine limit');
});

test('a video whose saved run failed on the old engine is handed to the native engine once',async()=>{
  const {fetchImpl,calls}=fakeApify({runStatus:n=>n===0?'FAILED':'SUCCEEDED'});
  let receipt={version:1,videoId:id,actorId:'memo23~youtube-video-downloader',runId:'Run0',state:'running',triedActors:['memo23~youtube-video-downloader'],createdAt:new Date().toISOString()};
  const store={read:async()=>receipt,write:async(_,v)=>{receipt=v;}};
  const r=await createApifyResolver({fetchImpl,log:quiet,sleep:async()=>{}})(id,{APIFY_TOKEN:'k'},{actor:'johnvc/youtube-download-api',store});
  assert.equal(r.actorId,'johnvc~youtube-download-api');
  assert.equal(calls.starts.length,1);
  assert.deepEqual(receipt.triedActors,['memo23~youtube-video-downloader','johnvc~youtube-download-api']);
});

test('a definite start rejection (4xx) is retried once minimally, then cleared — never a stuck receipt', async () => {
  let posts = 0; const routes = []; const bodies = [];
  let receipt = null; const store = { read: async () => receipt, write: async (_, v) => { receipt = v; } };
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST') { posts++; routes.push(url); bodies.push(JSON.parse(opts.body)); return Response.json({ error: { type: 'invalid-input', message: 'timeout too large' } }, { status: 400 }); }
    throw Error('unexpected ' + url);
  };
  await assert.rejects(createApifyResolver({ fetchImpl, log: quiet })(id, { APIFY_TOKEN: 'k' }, { actor: 'johnvc/youtube-download-api', store }), { code: 'apify_start_rejected' });
  assert.equal(posts, 2);
  assert.match(routes[0], /timeout=/); assert.doesNotMatch(routes[1], /timeout=/);
  assert.match(routes[1], /maxTotalChargeUsd=/);
  assert.equal(bodies[1].maxMinutes, undefined, 'minimal retry drops optional limits');
  assert.equal(bodies[0].maxMinutes, 720);
  assert.equal(receipt, null, 'nothing left that would block the video');
});

test('a rejection followed by a successful minimal start downloads normally', async () => {
  let posts = 0;
  const { fetchImpl: base } = fakeApify();
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST' && ++posts === 1) return Response.json({ error: { type: 'invalid-input', message: 'x' } }, { status: 400 });
    return base(url, opts);
  };
  const { store } = memStore();
  const r = await createApifyResolver({ fetchImpl, log: quiet, sleep: async () => {} })(id, { APIFY_TOKEN: 'k' }, { actor: 'johnvc/youtube-download-api', store });
  assert.equal(r.actorId, 'johnvc~youtube-download-api');
});

test('a receipt stuck in "starting" heals itself: adopt the matching run, or start cleanly when none exists', async () => {
  const stuck = () => ({ version: 1, videoId: id, actorId: 'johnvc~youtube-download-api', state: 'starting', tokenIndex: 0, triedActors: ['johnvc~youtube-download-api'], createdAt: new Date(Date.parse('2026-11-03T00:57:45Z')).toISOString() });
  const clock = () => Date.parse('2026-11-03T01:05:00Z');
  // (a) no run exists -> one clean start
  {
    const { fetchImpl: base, calls } = fakeApify();
    const fetchImpl = async (url, opts = {}) => url.includes('/acts/johnvc~youtube-download-api/runs?desc=1') ? Response.json({ data: { items: [] } }) : base(url, opts);
    let receipt = stuck(); const store = { read: async () => receipt, write: async (_, v) => { receipt = v; } };
    const r = await createApifyResolver({ fetchImpl, log: quiet, sleep: async () => {}, now: clock })(id, { APIFY_TOKEN: 'k' }, { actor: 'johnvc/youtube-download-api', store });
    assert.equal(calls.starts.length, 1); assert.equal(r.actorId, 'johnvc~youtube-download-api');
  }
  // (b) a run for this video exists -> adopted, no new start
  {
    const { fetchImpl: base, calls } = fakeApify();
    const fetchImpl = async (url, opts = {}) => {
      if (url.includes('/acts/johnvc~youtube-download-api/runs?desc=1')) return Response.json({ data: { items: [{ id: 'Run1', startedAt: '2026-11-03T00:57:46Z', defaultKeyValueStoreId: 'kv1' }] } });
      if (url.includes('/key-value-stores/kv1/records/INPUT')) return Response.json({ videoUrls: ['https://www.youtube.com/watch?v=' + id] });
      return base(url, opts);
    };
    let receipt = stuck(); const store = { read: async () => receipt, write: async (_, v) => { receipt = v; } };
    await createApifyResolver({ fetchImpl, log: quiet, sleep: async () => {}, now: clock })(id, { APIFY_TOKEN: 'k' }, { actor: 'johnvc/youtube-download-api', store });
    assert.equal(calls.starts.length, 0); assert.equal(receipt.runId, 'Run1');
  }
});

test('an unavailable video is final for 24h: no new attempt, then one fresh try', async () => {
  let t = Date.parse('2026-11-03T22:32:00Z');
  const { fetchImpl, calls } = fakeApify({ rowFor: () => ({ resultType: 'error', videoId: id, error: 'UNAVAILABLE', errorMessage: 'This video is unavailable' }) });
  const { store, get } = memStore();
  const resolver = createApifyResolver({ fetchImpl, log: quiet, sleep: async () => {}, now: () => t });
  await assert.rejects(resolver(id, { APIFY_TOKEN: 'k' }, { actor: 'johnvc/youtube-download-api', store }), { code: 'youtube_unavailable' });
  assert.equal(calls.starts.length, 1); assert.equal(get().state, 'final');
  t += 60 * 60 * 1000; // an hour later: answered at once, nothing started
  await assert.rejects(resolver(id, { APIFY_TOKEN: 'k' }, { actor: 'johnvc/youtube-download-api', store }), { code: 'youtube_unavailable' });
  assert.equal(calls.starts.length, 1);
  t += 24 * 60 * 60 * 1000; // a day later: one fresh attempt
  await assert.rejects(resolver(id, { APIFY_TOKEN: 'k' }, { actor: 'johnvc/youtube-download-api', store }), { code: 'youtube_unavailable' });
  assert.equal(calls.starts.length, 2);
});
