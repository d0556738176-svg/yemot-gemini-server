// One durable run receipt per video. Never restart a paid run on a local
// timeout, HTTP error, caller hangup or server restart.
const API_BASE='https://api.apify.com/v2';
const terminal=new Set(['FAILED','ABORTED','TIMED-OUT']);
const legacyRecoveryOnly=new Set(['Nb9xE8J6pgA','EZeWxl7N2DI']); // timed-out real call, 2026-10-28
const err=(code,message)=>Object.assign(new Error(message),{code});
export function isApifyConfigured(env=process.env){return !!String(env.APIFY_TOKEN||'').trim();}
// Multiple Apify accounts: the primary plus optional extras. When one account's
// free usage is exhausted (HTTP 402 on run start), the next is tried. A run's
// owning account is recorded in the receipt (tokenIndex) so a resume polls the
// same account that started it.
export function apifyTokens(env=process.env){
  return ['APIFY_TOKEN','APIFY_TOKEN_2','APIFY_TOKEN_3','APIFY_TOKEN_4']
    .map(k=>String(env[k]||'').trim()).filter(Boolean);
}
export function apifyReceiptPath(videoId){
  if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))throw err('invalid_video','Invalid video ID');
  return 'ivr2:/2/youtubejobs/'+Buffer.from(videoId).toString('hex')+'/run.json';
}
function resultFromItem(item,videoId,actorId,runId,token){
  if(!item||item.succeeded===false||item.status==='failed'||item.error)throw err('apify_actor_failed','Provider returned no audio');
  const itemId=item.videoId||item.video_id;
  if(itemId&&itemId!==videoId)throw err('apify_invalid_result','Provider returned a different video');
  // Never mistake the original YouTube watch URL for a downloadable audio file.
  const value=['download_url','fileUrl','downloadUrl','audioUrl','mp3Url','link']
    .map(k=>item[k]).find(v=>typeof v==='string'&&/^https:\/\//.test(v));
  if(!value)throw err('apify_no_file','Provider returned no audio file');
  const url=new URL(value);
  if(/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname))throw err('apify_no_file','Source page is not an audio file');
  if(url.hostname==='api.apify.com'&&!url.searchParams.has('token'))url.searchParams.set('token',token);
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
  if(/confirm.*not a bot|sign in to confirm|blocked on our side/.test(reason))return 'apify_provider_blocked';
  if(/tls|ssl|connection.*closed|connection.*reset/.test(reason))return 'apify_provider_network';
  if(run.status==='TIMED-OUT'||/timed out|timeout/.test(reason))return 'apify_provider_timeout';
  return 'apify_run_failed';
}

export function createApifyResolver({fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,log=console}={}){
  const active=new Map();
  return function resolve(videoId,env=process.env,options={}){
    const id=String(videoId||'').trim();
    const tokens=apifyTokens(env);
    if(!tokens.length)return Promise.reject(err('not_configured','APIFY_TOKEN not configured'));
    let token=tokens[0]; let tokenIndex=0;
    let path;try{path=apifyReceiptPath(id);}catch(e){return Promise.reject(e);}
    const store=options.store;
    if(!store?.read||!store?.write)return Promise.reject(err('cache_unavailable','Durable run storage required before starting provider'));
    // Per-call actor (chosen by video length) wins; an existing receipt still
    // keeps its own recorded actor below, so a video never switches provider.
    const actorId=String(options.actor||env.BRANCH2_APIFY_ACTOR||'memo23/youtube-video-downloader').trim().replace('/','~');
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
      const runTimeoutSec=Math.max(300,Math.min(7200,Number(env.BRANCH2_APIFY_RUN_TIMEOUT_SEC)||7200));
      const fallbackActor=options.fallbackActor?String(options.fallbackActor).trim().replace('/','~'):null;
      const allowFallback=String(env.BRANCH2_APIFY_ENGINE_FALLBACK||'on').toLowerCase()!=='off';
      // Starts ONE fresh run for `useActor`, trying each Apify account in turn and
      // moving to the next only when an account is out of free usage (HTTP 402).
      // Intent (account + actor) is written before each POST so a lost ack fails
      // closed (no duplicate charge); triedActors tracks which engines were used.
      async function startRun(useActor,tried){
        const watch='https://www.youtube.com/watch?v='+id;
        const maxCharge=useActor.startsWith('memo23~')?'0.06':'0.25';
        const route='/acts/'+useActor+'/runs?restartOnError=false&timeout='+runTimeoutSec+'&maxTotalChargeUsd='+maxCharge;
        const payload=JSON.stringify({urls:[watch],videoUrls:[watch],url:watch,videoUrl:watch,
          format:'mp3',audioQuality:'192',quality:'best',downloadSubtitles:false,metadataOnly:false});
        for(let ti=0;ti<tokens.length;ti++){
          receipt={version:1,videoId:id,actorId:useActor,state:'starting',triedActors:tried,tokenIndex:ti,createdAt:new Date(now()).toISOString()};
          await store.write(path,receipt);
          let r;
          try{r=await fetchImpl(API_BASE+route,{method:'POST',headers:{authorization:'Bearer '+tokens[ti],'content-type':'application/json'},body:payload,signal:AbortSignal.timeout(30000)});}
          catch{throw err('apify_start_uncertain','Provider response unavailable; existing run retained');}
          if(r.status===402){ log.info?.('[YouTube IVR] provider account out of free usage; trying next',{videoId:id,account:ti+1}); continue; }
          const b=await r.json().catch(()=>null);
          if(!r.ok||!/^[A-Za-z0-9]+$/.test(String(b?.data?.id||'')))throw err('apify_start_uncertain','Provider run ID missing; duplicate blocked');
          token=tokens[ti]; tokenIndex=ti;
          receipt={...receipt,runId:b.data.id,state:'running'};
          await store.write(path,receipt);
          return b.data.id;
        }
        // Every account is out of free usage: nothing started or charged, so clear
        // the blocking receipt to allow a retry later (free usage resets monthly).
        await store.write(path,null).catch(()=>{});
        throw err('needs_payment','All provider accounts are out of free usage');
      }
      let receipt=await store.read(path);
      if(receipt&&(receipt.version!==1||receipt.videoId!==id))throw err('cache_invalid','Invalid provider receipt');
      // Resume with the SAME account that started the run (so the run id is valid).
      if(receipt&&Number.isInteger(receipt.tokenIndex)&&tokens[receipt.tokenIndex]){token=tokens[receipt.tokenIndex];tokenIndex=receipt.tokenIndex;}
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
      for(;;){
        const b=await api('/actor-runs/'+receipt.runId);
        const run=b.data;
        if(!run?.status)throw err('apify_pending','Missing run state; saved run retained');
        if(run.status==='SUCCEEDED'){
          if(!/^[A-Za-z0-9]+$/.test(String(run.defaultDatasetId||'')))throw err('apify_no_file','Completed run has no dataset');
          const rows=await api('/datasets/'+run.defaultDatasetId+'/items?format=json&clean=true&limit=2');
          if(!Array.isArray(rows)||rows.length!==1)throw err('apify_no_file','Completed run has no single audio result');
          const result=resultFromItem(rows[0],id,receipt.actorId,receipt.runId,token);
          log.info('[YouTube IVR] provider run completed',{videoId:id,runId:receipt.runId,reusedRun:true});
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
                .filter(line=>/error|failed|timeout|timed.out|exceed|limit|killed|oom|memory|no video|no audio|unable|forbidden|403|429/i.test(line))
                .slice(-8).map(line=>redactProviderDiagnostic(line,token));
            }
          }catch{ /* diagnostics must not change billing/retry behavior */ }
          log.warn?.('[YouTube IVR] provider terminal diagnosis',{
            videoId:id,runId:receipt.runId,status:run.status,exitCode:run.exitCode??null,
            statusMessage:redactProviderDiagnostic(run.statusMessage,token),
            usageTotalUsd:run.usageTotalUsd??null,maxTotalChargeUsd:run.options?.maxTotalChargeUsd??null,
            errorLines:lines,newRunStarted:false
          });
          const failCode=classifyProviderTerminal(run,lines);
          // Engine fallback: a FAILED/ABORTED/TIMED-OUT run produced nothing
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
        if(now()>=until)throw err('apify_pending','Provider still working; saved run will be resumed');
        await sleep(5000);
      }
    })().finally(()=>active.delete(key));
    active.set(key,task);return task;
  };
}
export const resolveApifyAudio=createApifyResolver();
