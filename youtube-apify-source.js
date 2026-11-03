import { createHash } from 'node:crypto';
import { parseProviderProgress, parseNativeAttempts, boundedLogText } from './youtube-provider-progress.js';
// One durable run receipt per video. Never restart a paid run on a local
// timeout, HTTP error, caller hangup or server restart.
const API_BASE='https://api.apify.com/v2';
const terminal=new Set(['FAILED','ABORTED','TIMED-OUT']);
const legacyRecoveryOnly=new Set(['Nb9xE8J6pgA','EZeWxl7N2DI']); // timed-out real call, 2026-10-28
const err=(code,message)=>Object.assign(new Error(message),{code});
export const NATIVE_ACTOR_ID='johnvc~youtube-download-api';
// Native audio is ~$0.00001 per delivered minute; the cap is derived from the
// longest allowed video so a legitimate long file is never cut off mid-run.
export function nativeLimits(env=process.env){
  const maxMinutes=Math.max(10,Math.min(1440,Math.floor(Number(env.BRANCH2_NATIVE_MAX_MINUTES)||900)));
  const maxMegabytes=Math.max(16,Math.min(4096,Math.floor(Number(env.BRANCH2_MAX_SOURCE_MB)||1024)));
  const maxCharge=Math.max(0.01,Number(env.BRANCH2_NATIVE_MAX_CHARGE_USD)||0,
    Math.ceil((maxMinutes*0.00001+0.002)*1000)/1000);
  return {maxMinutes,maxMegabytes,maxCharge:maxCharge.toFixed(3)};
}
// Every Apify account key, in priority order: APIFY_TOKEN, APIFY_TOKEN_2..20,
// then any comma/space separated APIFY_TOKENS list. Duplicates are dropped.
export function apifyTokens(env=process.env){
  const named=['APIFY_TOKEN','APIFY_API_TOKEN'];
  for(let i=2;i<=20;i++)named.push('APIFY_TOKEN_'+i);
  const list=[...named.map(k=>env[k]),...String(env.APIFY_TOKENS||'').split(/[\s,;]+/)]
    .map(v=>String(v||'').trim()).filter(Boolean);
  return [...new Set(list)];
}
export function isApifyConfigured(env=process.env){return apifyTokens(env).length>0;}
// A short non-reversible fingerprint identifies which account owns a saved run,
// so adding, removing or re-ordering keys never polls a run with the wrong key.
export function tokenFingerprint(token){return createHash('sha256').update(String(token)).digest('hex').slice(0,12);}
// Account-level start refusals: no run was created, so the next key is safe.
// 401 bad/revoked key, 402 out of credit, 403 account/actor not permitted,
// 429 account rate limit.
const ACCOUNT_REFUSAL=new Set([401,402,403,429]);
// The video itself cannot be delivered; no engine or key will change that.
const PERMANENT_CODES=new Set(['too_large','youtube_unavailable']);
// Map a native error/skipped row to a precise code so the caller hears the
// real reason and only recoverable failures reach the backup engine.
export function classifyNativeRow(item){
  const type=String(item?.resultType||'').toLowerCase();
  const text=[item?.error,item?.errorMessage,item?.note].map(v=>String(v||'')).join(' ').toLowerCase();
  if(type==='skipped'||/max_?minutes|max_?megabytes|too (long|large)|exceeds/.test(text))return 'too_large';
  if(/private|unavailable|removed|deleted|members[- ]only|age[- ]restrict|copyright|not available in your country|geo/.test(text))return 'youtube_unavailable';
  if(/not a bot|sign in to confirm|bot|captcha/.test(text))return 'apify_provider_blocked';
  if(/not_processed|charge|spending|limit/.test(text))return 'apify_run_failed';
  if(/timeout|timed out/.test(text))return 'apify_provider_timeout';
  if(/network|tls|ssl|connection|storage_unavailable/.test(text))return 'apify_provider_network';
  return 'apify_actor_failed';
}
export function apifyReceiptPath(videoId){
  if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))throw err('invalid_video','Invalid video ID');
  return 'ivr2:/2/youtubejobs/'+Buffer.from(videoId).toString('hex')+'/run.json';
}
function resultFromItem(item,videoId,actorId,runId,token){
  const native=actorId===NATIVE_ACTOR_ID;
  if(native&&item&&item.resultType!=='file')throw err(classifyNativeRow(item),'Native engine returned '+String(item.resultType||'no')+' row');
  if(!item||item.succeeded===false||item.status==='failed'||item.error)throw err('apify_actor_failed','Provider returned no audio');
  if(native&&(item.resultType!=='file'||item.videoId!==videoId||!Number.isFinite(item.durationSeconds)||item.durationSeconds<=0||!Number.isSafeInteger(item.fileSizeBytes)||item.fileSizeBytes<=0||!/^[a-f0-9]{64}$/i.test(item.sha256||'')))throw err('apify_invalid_result','Native audio result lacks verified identity or integrity metadata');
  const itemId=item.videoId||item.video_id;
  if(itemId&&itemId!==videoId)throw err('apify_invalid_result','Provider returned a different video');
  // Never mistake the original YouTube watch URL for a downloadable audio file.
  const value=['download_url','fileUrl','downloadUrl','audioUrl','mp3Url','link']
    .map(k=>item[k]).find(v=>typeof v==='string'&&/^https:\/\//.test(v));
  if(!value)throw err('apify_no_file','Provider returned no audio file');
  const url=new URL(value);
  if(/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname))throw err('apify_no_file','Source page is not an audio file');
  if(url.hostname==='api.apify.com'&&!url.searchParams.has('token')&&!url.searchParams.has('signature'))url.searchParams.set('token',token);
  return {url:url.toString(),item,actorId,runId,title:item.title||null,
    durationSeconds:item.durationSeconds||item.durationSec||item.duration_seconds||item.duration||null};
}

export function redactProviderDiagnostic(value,token=''){
  let text=String(value||'');
  if(token)text=text.split(token).join('[redacted]');
  return text.replace(/https?:\/\/\S+/g,'[url]')
    .replace(/(?:Bearer|token|password|cookie|authorization)\s*[:= ]+\S+/gi,'[credential]')
    .replace(/[A-Za-z0-9_-]{24,}/g,'[redacted]').slice(0,320);
}


export function classifyProviderTerminal(run,lines=[]){
  const reason=[run.statusMessage||'',...lines].join('\n').toLowerCase();
  // A genuine YouTube bot-wall is the only thing we treat as a true "block": it
  // will not clear by re-running the same engine, so it goes to the fast engine.
  if(/not a bot|sign in to confirm/.test(reason))return 'apify_provider_blocked';
  // A generic actor summary calls every failed route blocked. Concrete slow
  // download evidence must win over that wording and over incidental TLS errors.
  if(/download too slow|download stalled|too slow to finish/.test(reason))return 'apify_provider_slow';
  // Concrete connection/TLS/read-timeout errors are network trouble reaching
  // YouTube (often transient or throttling), NOT a deliberate block — even when
  // the actor's own summary generically calls it "blocked on our side". These
  // are retryable, so this concrete signal must win over that generic wording.
  if(/tls|ssl|handshake|connection.*(closed|reset)|read timed out|failed to receive data|decoding the received/.test(reason))return 'apify_provider_network';
  if(run.status==='TIMED-OUT'||/timed out|timeout/.test(reason))return 'apify_provider_timeout';
  // Generic actor "blocked" summary with no concrete network or bot signal.
  if(/blocked on our side/.test(reason))return 'apify_provider_blocked';
  return 'apify_run_failed';
}

// Build the Apify ad-hoc `webhooks` run-start parameter so the provider notifies
// our server when a download run reaches any terminal state. That
// inbound request wakes a spun-down free-tier Render instance exactly when the
// result can be reconciled, including failures, without
// keeping the server awake the whole time. The value is a URL-encoded,
// base64-encoded JSON array (Apify's required format). The shared secret lives
// only in a Render env var and is never logged. Returns '' when no public URL or
// secret is configured (local/test), leaving behaviour unchanged.
export function apifyWebhookQuery(env=process.env,videoId=''){
  const base=String(env.RENDER_EXTERNAL_URL||env.PUBLIC_BASE_URL||'').trim().replace(/\/+$/,'');
  const secret=String(env.BRANCH2_WEBHOOK_SECRET||'').trim();
  if(!base||!secret||!/^[A-Za-z0-9_-]{11}$/.test(String(videoId||'')))return '';
  const requestUrl=base+'/apify-webhook?videoId='+encodeURIComponent(videoId)+'&secret='+encodeURIComponent(secret);
  const json=JSON.stringify([{eventTypes:['ACTOR.RUN.SUCCEEDED','ACTOR.RUN.FAILED','ACTOR.RUN.ABORTED','ACTOR.RUN.TIMED_OUT'],requestUrl}]);
  return '&webhooks='+encodeURIComponent(Buffer.from(json,'utf8').toString('base64'));
}

export function createApifyResolver({fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,log=console}={}){
  const active=new Map();
  return function resolve(videoId,env=process.env,options={}){
    if(options.signal?.aborted)return Promise.reject(options.signal.reason||err('apify_pending','Local preparation cancelled'));
    const id=String(videoId||'').trim();
    const tokens=apifyTokens(env);
    if(!tokens.length)return Promise.reject(err('not_configured','APIFY_TOKEN not configured'));
    let token=tokens[0]; let tokenIndex=0;
    let path;try{path=apifyReceiptPath(id);}catch(e){return Promise.reject(e);}
    const store=options.store;
    if(!store?.read||!store?.write)return Promise.reject(err('cache_unavailable','Durable run storage required before starting provider'));
    // Per-call actor (chosen by video length) wins; an existing receipt still
    // keeps its own recorded actor below, so a video never switches provider.
    const actorId=String(options.actor||NATIVE_ACTOR_ID).trim().replace('/','~');
    const key=id; // changing provider must not evade an existing video's receipt
    if(active.has(key))return active.get(key);
    const task=(async()=>{
      async function api(route,{method='GET',body,timeout=20000}={}){
        let r;
        try{r=await fetchImpl(API_BASE+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
          ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeout)});}
        catch{throw err(method==='POST'?'apify_start_uncertain':'apify_pending','Provider response unavailable; existing run retained');}
        const b=await r.json().catch(()=>null);
        if(!r.ok)throw err(method==='POST'?'apify_start_uncertain':'apify_pending','Provider HTTP '+r.status+'; no new run started');
        if(!b)throw err('apify_pending','Provider returned invalid JSON');
        return b;
      }
      // Longer, configurable actor run timeout: memo23 is slow and a big video
      // was aborted at the old 1200s. The other engine (passed as fallbackActor)
      // is tried once if a run ends FAILED/ABORTED/TIMED-OUT.
      // memo23 is slow; give it a full hour (configurable) before the fast engine
      // takes over, so large videos finish on the cheap engine when possible.
      // A 12-hour native file took ~10 min per hour of audio in testing, so the
      // native run gets up to 4 hours; old engines keep their 2-hour limit.
      const runTimeoutSec=actorId===NATIVE_ACTOR_ID
        ?Math.max(600,Math.min(21600,Number(env.BRANCH2_NATIVE_RUN_TIMEOUT_SEC)||14400))
        :Math.max(300,Math.min(7200,Number(env.BRANCH2_APIFY_RUN_TIMEOUT_SEC)||7200));
      // Native-only: no other engine is ever started, whatever a caller passes.
      const fallbackActor=actorId===NATIVE_ACTOR_ID?null:(options.fallbackActor?String(options.fallbackActor).trim().replace('/','~'):null);
      const allowFallback=String(env.BRANCH2_APIFY_ENGINE_FALLBACK||'on').toLowerCase()!=='off';
      // Native runs that fail cost nothing, so one fresh native retry is the
      // default (each may land on a new route/worker). 0 disables them.
      const nativeRetries=()=>{const n=Number(env.BRANCH2_NATIVE_RETRIES??2);return Number.isFinite(n)?Math.max(0,Math.min(4,Math.floor(n))):2;};
      // Starts ONE fresh run for `useActor`, trying each Apify account in turn and
      // moving to the next only when an account is out of free usage (HTTP 402).
      // Intent (account + actor) is written before each POST so a lost ack fails
      // closed (no duplicate charge); triedActors tracks which engines were used.
      async function startRun(useActor,tried,attemptNo=1){
        if(options.signal?.aborted)throw options.signal.reason||err('apify_pending','Local preparation cancelled; saved run retained');
        const watch='https://www.youtube.com/watch?v='+id;
        const native=useActor===NATIVE_ACTOR_ID;
        const limits=nativeLimits(env);
        const isLongEngine=useActor.startsWith('memo23~');
        const maxCharge=native?limits.maxCharge:isLongEngine?'0.06':'0.25';
        const perVideoTimeoutSecs=isLongEngine?300:180;
        // Output bitrate is a conversion preference, not a guarantee that the
        // actor fetches fewer source bytes. The documented attempt timeout is
        // capped at 300s; asking for more cannot fix a slow provider route.
        const audioQuality=isLongEngine
          ? String(env.BRANCH2_APIFY_AUDIO_QUALITY_LONG||'96').trim()
          : String(env.BRANCH2_APIFY_AUDIO_QUALITY_SHORT||env.BRANCH2_APIFY_AUDIO_QUALITY||'192').trim();
        const route='/acts/'+useActor+'/runs?restartOnError=false&timeout='+runTimeoutSec+'&maxTotalChargeUsd='+maxCharge+apifyWebhookQuery(env,id);
        // Native m4a is YouTube's own audio track (no re-encode, fastest). The
        // phone line is 8kHz mono, so 'standard' loses nothing audible and keeps
        // long files small enough for the free server's disk.
        const nativeQuality=String(env.BRANCH2_NATIVE_AUDIO_QUALITY||'standard').trim()==='high'?'high':'standard';
        const payload=JSON.stringify(native?{videoUrls:[watch],format:'audio',audioFormat:'m4a',audioQuality:nativeQuality,storageProvider:'apify',metadataOnly:false,maxMinutes:limits.maxMinutes,maxMegabytes:limits.maxMegabytes}:{urls:[watch],videoUrls:[watch],url:watch,videoUrl:watch,
          format:'mp3',audioQuality,quality:'best',downloadSubtitles:false,metadataOnly:false,
          ...(isLongEngine?{perVideoTimeoutSecs,maxConcurrency:1}:{})});
        // Start on the account that owns the current run when it still works,
        // then every other key in order: each backup key runs the same engine.
        const order=[tokenIndex,...tokens.map((_,i)=>i).filter(i=>i!==tokenIndex)];
        const refusals=[];
        for(const ti of order){
          receipt={version:1,videoId:id,actorId:useActor,state:'starting',triedActors:tried,tokenIndex:ti,tokenFp:tokenFingerprint(tokens[ti]),runTimeoutSec,perVideoTimeoutSecs,attemptCount:attemptNo,createdAt:new Date(now()).toISOString()};
          await store.write(path,receipt);
          let r;
          try{r=await fetchImpl(API_BASE+route,{method:'POST',headers:{authorization:'Bearer '+tokens[ti],'content-type':'application/json'},body:payload,signal:AbortSignal.timeout(30000)});}
          catch{throw err('apify_start_uncertain','Provider response unavailable; existing run retained');}
          if(ACCOUNT_REFUSAL.has(r.status)){
            refusals.push(r.status);
            log.info?.('[YouTube IVR] provider account refused run start; trying next key',{videoId:id,account:ti+1,of:tokens.length,status:r.status,actorId:useActor});
            continue;
          }
          const b=await r.json().catch(()=>null);
          if(!r.ok||!/^[A-Za-z0-9]+$/.test(String(b?.data?.id||'')))throw err('apify_start_uncertain','Provider run ID missing; duplicate blocked');
          token=tokens[ti]; tokenIndex=ti;
          receipt={...receipt,runId:b.data.id,state:'running'};
          try{options.onProgress?.({stage:'provider',providerPercent:null});}catch{}
          await store.write(path,receipt);
          return b.data.id;
        }
        // Every account refused before creating a run: nothing started or
        // charged, so clear the blocking receipt to allow a later retry.
        await store.write(path,null).catch(()=>{});
        log.warn?.('[YouTube IVR] every provider key refused run start',{videoId:id,keys:tokens.length,statuses:refusals});
        throw err(refusals.every(s=>s===402)?'needs_payment':'apify_accounts_unavailable','All provider accounts refused the run');
      }
      let receipt=await store.read(path);
      if(receipt&&(receipt.version!==1||receipt.videoId!==id))throw err('cache_invalid','Invalid provider receipt');
      // Resume with the SAME account that started the run (so the run id is valid).
      if(receipt){
        const byFp=receipt.tokenFp?tokens.findIndex(t=>tokenFingerprint(t)===receipt.tokenFp):-1;
        const owner=byFp>=0?byFp:(!receipt.tokenFp&&Number.isInteger(receipt.tokenIndex)&&tokens[receipt.tokenIndex]?receipt.tokenIndex:-1);
        if(owner>=0){token=tokens[owner];tokenIndex=owner;}
        else if(receipt.tokenFp&&receipt.runId)log.warn?.('[YouTube IVR] key that owns saved run is no longer configured',{videoId:id,runId:receipt.runId});
      }
      if(!receipt&&legacyRecoveryOnly.has(id)){
        // Adopt the old synchronous run using GETs only. Missing history must
        // never trigger another charged attempt for this failed call.
        const list=await api('/acts/'+actorId+'/runs?desc=1&limit=100');
        let previous;
        for(const run of list?.data?.items||[]){
          if(!run.defaultKeyValueStoreId)continue;
          const input=await api('/key-value-stores/'+run.defaultKeyValueStoreId+'/records/INPUT');
          const urls=input.videoUrls||input.urls||[input.videoUrl||input.url];
          if(input.format==='mp3'&&urls.length===1&&String(urls[0]).includes(id)){previous=run;break;}
        }
        if(!previous?.id)throw err('apify_start_uncertain','Previous run not found; duplicate download blocked');
        receipt={version:1,videoId:id,actorId,runId:previous.id,state:'running',adopted:true,triedActors:[actorId]};
        await store.write(path,receipt);
        log.info('[YouTube IVR] previous provider run adopted',{videoId:id,runId:receipt.runId,newRunStarted:false});
      }
      if(!receipt){
        log.info('[YouTube IVR] provider run started',{videoId:id,actorId,runId:await startRun(actorId,[actorId])});
      }
      if(!receipt.runId)throw err('apify_start_uncertain','Unconfirmed earlier start; duplicate download blocked');
      if(!/^[A-Za-z0-9]+$/.test(receipt.runId))throw err('cache_invalid','Invalid saved run ID');
      // Poll long enough to cover the whole run (plus a margin for the engine
      // fallback) in one keep-alive-sustained session, so a long download finishes
      // on its own without needing a second call.
      const waitMs=Number(env.BRANCH2_APIFY_WAIT_MS)||(runTimeoutSec*1000+600000);
      const until=now()+Math.max(1000,Math.min(waitMs,8000000));
      let lastProgressPoll=-Infinity,lastProgressWrite=-Infinity,restoredProgressSent=false;
      // Real facts only: a provider percentage when the engine prints one, and
      // for the native engine (which prints none while downloading) the route
      // attempts it has finished plus when the engine run really started.
      let nativeAttempts=null,runStartedAt=null;
      function reportProvider(sample,restored=false){
        try{options.onProgress?.({stage:'provider',providerPercent:sample?.percent??null,
          providerObservedAt:sample?.observedAt||null,providerRunId:receipt.runId,
          providerStale:restored||!!sample?.observedAt&&now()-Date.parse(sample.observedAt)>60000,
          providerStartedAt:runStartedAt,providerAttempts:nativeAttempts});}catch{}
      }
      async function refreshProviderProgress(){
        if(typeof options.onProgress!=='function'||now()-lastProgressPoll<30000)return;
        lastProgressPoll=now();
        try{
          const response=await fetchImpl(API_BASE+'/logs/'+receipt.runId+'?stream=false',{
            headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
          if(!response.ok)throw Error('log unavailable');
          const logText=await boundedLogText(response);
          const parsed=parseProviderProgress(logText);
          nativeAttempts=parseNativeAttempts(logText)||nativeAttempts;
          const sample=parsed?{...parsed,runId:receipt.runId}:null;
          const previous=receipt.progress;
          reportProvider(sample);
          if(JSON.stringify(previous)!==JSON.stringify(sample)&&
            (sample===null||!previous||Math.abs(sample.percent-previous.percent)>=5||now()-lastProgressWrite>=30000)){
            const updated={...receipt,progress:sample};
            try{
              await store.write(path,updated);receipt=updated;lastProgressWrite=now();
              log.info?.('[YouTube IVR] provider progress saved',{videoId:id,runId:receipt.runId,percent:sample?.percent??null,observedAt:sample?.observedAt||null});
            }
            catch{log.warn?.('[YouTube IVR] provider progress persistence unavailable',{videoId:id});}
          }
        }catch{
          // A status/log request failing must never restart a paid download.
          reportProvider(receipt.progress?.runId===receipt.runId?receipt.progress:null,true);
        }
      }

      for(;;){
        if(options.signal?.aborted)throw options.signal.reason||err('apify_pending','Local preparation cancelled; saved run retained');
        const b=await api('/actor-runs/'+receipt.runId);
        const run=b.data;
        if(!run?.status)throw err('apify_pending','Missing run state; saved run retained');
        if(run.startedAt)runStartedAt=run.startedAt;
        if(!terminal.has(run.status)&&run.status!=='SUCCEEDED'){
          if(!restoredProgressSent&&receipt.progress?.runId===receipt.runId)reportProvider(receipt.progress,true);
          restoredProgressSent=true;
          await refreshProviderProgress();
        }
        if(run.status==='SUCCEEDED'){
          if(!/^[A-Za-z0-9]+$/.test(String(run.defaultDatasetId||'')))throw err('apify_no_file','Completed run has no dataset');
          const rows=await api('/datasets/'+run.defaultDatasetId+'/items?format=json&clean=true&limit=2');
          let result;
          try{
            if(!Array.isArray(rows)||rows.length!==1)throw err('apify_no_file','Completed run has no single audio result');
            result=resultFromItem(rows[0],id,receipt.actorId,receipt.runId,token);
          }catch(rowError){
            // A native error row is free and nothing usable was delivered, so a
            // fresh native run (any key) or the backup engine is a new attempt.
            const code=rowError.code||'apify_actor_failed';
            log.warn?.('[YouTube IVR] provider run finished without audio',{videoId:id,runId:receipt.runId,actorId:receipt.actorId,code,
              rowType:Array.isArray(rows)?String(rows[0]?.resultType||''):'',detail:redactProviderDiagnostic(Array.isArray(rows)?(rows[0]?.errorMessage||rows[0]?.error||''):'',token)});
            if(PERMANENT_CODES.has(code))throw rowError;
            const attempts=Number.isFinite(receipt.attemptCount)?receipt.attemptCount:1;
            const tried=Array.isArray(receipt.triedActors)?receipt.triedActors:[receipt.actorId];
            if(actorId===NATIVE_ACTOR_ID&&receipt.actorId!==NATIVE_ACTOR_ID&&!tried.includes(NATIVE_ACTOR_ID)&&code!=='youtube_unavailable'){
              log.info('[YouTube IVR] earlier engine delivered no audio; handing video to native engine',{videoId:id,from:receipt.actorId,prevCode:code});
              log.info('[YouTube IVR] provider run started',{videoId:id,actorId,native:true,runId:await startRun(actorId,[...tried,actorId])});
              continue;
            }
            if(receipt.actorId===NATIVE_ACTOR_ID&&code!=='apify_invalid_result'&&attempts<=nativeRetries()){
              log.info('[YouTube IVR] retrying native engine fresh',{videoId:id,attempt:attempts+1,prevCode:code});
              log.info('[YouTube IVR] provider run started',{videoId:id,actorId:receipt.actorId,retry:true,runId:await startRun(receipt.actorId,tried,attempts+1)});
              continue;
            }
            if(allowFallback&&options.consentToFallback&&fallbackActor&&!tried.includes(fallbackActor)){
              log.info('[YouTube IVR] provider engine fallback',{videoId:id,from:receipt.actorId,to:fallbackActor,prevCode:code});
              log.info('[YouTube IVR] provider run started',{videoId:id,actorId:fallbackActor,fallback:true,runId:await startRun(fallbackActor,[...tried,fallbackActor])});
              continue;
            }
            throw rowError;
          }
          log.info('[YouTube IVR] provider run completed',{videoId:id,runId:receipt.runId,actorId:receipt.actorId,reusedRun:true});
          return result;
        }
        if(terminal.has(run.status)){
          let lines=[];
          try{
            const response=await fetchImpl(API_BASE+'/actor-runs/'+receipt.runId+'/log',{
              headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
            if(response.ok){
              const text=await response.text();
              lines=text.slice(-100000).split('\n')
                .filter(line=>/error|failed|timeout|timed.out|exceed|limit|killed|oom|memory|no video|no audio|unable|forbidden|403|429|too slow|stalled/i.test(line))
                .filter(line=>!/If there are any errors|free user, your access|LIMITED_PERMISSIONS/i.test(line))
                .slice(-12).map(line=>redactProviderDiagnostic(line,token));
            }
          }catch{ /* diagnostics must not change billing/retry behavior */ }
          log.warn?.('[YouTube IVR] provider terminal diagnosis',{
            videoId:id,runId:receipt.runId,status:run.status,exitCode:run.exitCode??null,
            statusMessage:redactProviderDiagnostic(run.statusMessage,token),
            usageTotalUsd:run.usageTotalUsd??null,maxTotalChargeUsd:run.options?.maxTotalChargeUsd??null,
            errorLines:lines,newRunStarted:false
          });
          const failCode=classifyProviderTerminal(run,lines);
          const triedNow=Array.isArray(receipt.triedActors)?receipt.triedActors:[receipt.actorId];
          // A run saved by an older engine must not lock the video out of the
          // native engine: a native attempt is the cheaper one, so it needs no
          // consent and is still a single new attempt (never repeated).
          if(actorId===NATIVE_ACTOR_ID&&receipt.actorId!==NATIVE_ACTOR_ID&&!triedNow.includes(NATIVE_ACTOR_ID)){
            log.info('[YouTube IVR] earlier engine failed; handing video to native engine',{videoId:id,from:receipt.actorId,prevCode:failCode});
            log.info('[YouTube IVR] provider run started',{videoId:id,actorId,native:true,runId:await startRun(actorId,[...triedNow,actorId])});
            continue;
          }
          const ageMs=now()-(Date.parse(receipt.createdAt)||0);
          const attempts=Number.isFinite(receipt.attemptCount)?receipt.attemptCount:1;
          // A durable per-engine budget never resets with age or a process restart.
          // One fresh retry by default; explicit zero disables it. Never retry a
          // bot wall or an unclassified failure that may be permanent.
          const configured=Number(env.BRANCH2_MAX_CHEAP_RETRIES ?? 1);
          const maxCheapRetries=Number.isFinite(configured)?Math.max(0,Math.min(3,Math.floor(configured))):1;
          const blocked=failCode==='apify_provider_blocked';
          const transient=failCode==='apify_provider_network';
          const timeoutRaised=failCode==='apify_provider_timeout'&&
            (!Number.isFinite(receipt.perVideoTimeoutSecs)||receipt.perVideoTimeoutSecs<300);
          const cheapEngine=receipt.actorId.startsWith('memo23~');
          // A failed native run is not charged, so it gets its own retry budget
          // on any failure; the next run lands on a different worker/route.
          const retryReason=receipt.actorId===NATIVE_ACTOR_ID
            ?(attempts<=nativeRetries()?'native_retry':null)
            :cheapEngine&&!blocked&&attempts<=maxCheapRetries&&
            (transient||timeoutRaised)?(transient?'transient_retry':'attempt_timeout_raised'):null;
          if(retryReason){
            const nextAttempt=attempts+1;
            log.info('[YouTube IVR] retrying failed run fresh on the cheap engine',{videoId:id,reason:retryReason,ageMs,attempt:nextAttempt,prevCode:failCode});
            log.info('[YouTube IVR] provider run started',{videoId:id,actorId:receipt.actorId,retry:true,runId:await startRun(receipt.actorId,Array.isArray(receipt.triedActors)?receipt.triedActors:[receipt.actorId],nextAttempt)});
            continue;
          }
          // Engine fallback: a recent FAILED/ABORTED/TIMED-OUT run produced nothing
          // usable, so trying the OTHER engine once is a new attempt, not a
          // duplicate. Each engine is tried at most once (triedActors), so there
          // is no loop and no second charge on an engine that already ran.
          const tried=Array.isArray(receipt.triedActors)?receipt.triedActors:[receipt.actorId];
          // Only switch to the other (costlier) engine with the caller's consent.
          if(allowFallback&&options.consentToFallback&&fallbackActor&&!tried.includes(fallbackActor)){
            log.info('[YouTube IVR] provider engine fallback',{videoId:id,from:receipt.actorId,to:fallbackActor,prevCode:failCode});
            log.info('[YouTube IVR] provider run started',{videoId:id,actorId:fallbackActor,fallback:true,runId:await startRun(fallbackActor,[...tried,fallbackActor])});
            continue;
          }
          throw err(failCode,'Saved provider run ended '+run.status+'; automatic paid retry blocked');
        }
        // A remote RUNNING state is not proof that the run has stopped. Keep
        // its receipt; never create a second billed run alongside it.
        const startedMs=Date.parse(run.startedAt);
        const createdMs=Date.parse(receipt.createdAt);
        const baseMs=Number.isFinite(startedMs)?startedMs:createdMs;
        const savedTimeout=Number(receipt.runTimeoutSec)||runTimeoutSec;
        if(Number.isFinite(baseMs)&&now()-baseMs>(savedTimeout+600)*1000){
          log.warn?.('[YouTube IVR] provider run overdue; duplicate start blocked',{videoId:id,runId:receipt.runId});
          throw err('apify_pending','Provider state overdue; saved run retained for reconciliation');
        }
        if(now()>=until)throw err('apify_pending','Provider still working; saved run will be resumed');
        await sleep(5000);
      }
    })().finally(()=>active.delete(key));
    active.set(key,task);return task;
  };
}
export const resolveApifyAudio=createApifyResolver();




