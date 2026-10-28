// One durable run receipt per video. Never restart a paid run on a local
// timeout, HTTP error, caller hangup or server restart.
const API_BASE='https://api.apify.com/v2';
const terminal=new Set(['FAILED','ABORTED','TIMED-OUT']);
const legacyRecoveryOnly=new Set(['Nb9xE8J6pgA','EZeWxl7N2DI']); // timed-out real call, 2026-10-28
const err=(code,message)=>Object.assign(new Error(message),{code});
export function isApifyConfigured(env=process.env){return !!String(env.APIFY_TOKEN||'').trim();}
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
    const token=String(env.APIFY_TOKEN||'').trim();
    if(!token)return Promise.reject(err('not_configured','APIFY_TOKEN not configured'));
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
      let receipt=await store.read(path);
      if(receipt&&(receipt.version!==1||receipt.videoId!==id))throw err('cache_invalid','Invalid provider receipt');
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
        receipt={version:1,videoId:id,actorId,runId:previous.id,state:'running',adopted:true};
        await store.write(path,receipt);
        log.info('[YouTube IVR] previous provider run adopted',{videoId:id,runId:receipt.runId,newRunStarted:false});
      }
      if(!receipt){
        // Publish intent BEFORE the sole POST. If acknowledgement is lost,
        // later attempts fail closed rather than guessing whether it was billed.
        receipt={version:1,videoId:id,actorId,state:'starting',createdAt:new Date(now()).toISOString()};
        await store.write(path,receipt);
        const watch='https://www.youtube.com/watch?v='+id;
        const maxCharge=actorId.startsWith('memo23~')?'0.06':'0.25';
        const b=await api('/acts/'+actorId+'/runs?restartOnError=false&timeout=1200&maxTotalChargeUsd='+maxCharge,{
          method:'POST',timeout:30000,body:{urls:[watch],videoUrls:[watch],url:watch,videoUrl:watch,
            format:'mp3',audioQuality:'192',quality:'best',downloadSubtitles:false,metadataOnly:false}});
        if(!/^[A-Za-z0-9]+$/.test(String(b?.data?.id||'')))throw err('apify_start_uncertain','Provider run ID missing; duplicate blocked');
        receipt={...receipt,runId:b.data.id,state:'running'};
        await store.write(path,receipt);
        log.info('[YouTube IVR] provider run started',{videoId:id,actorId,runId:receipt.runId});
      }
      if(!receipt.runId)throw err('apify_start_uncertain','Unconfirmed earlier start; duplicate download blocked');
      if(!/^[A-Za-z0-9]+$/.test(receipt.runId))throw err('cache_invalid','Invalid saved run ID');
      const waitMs=Number(env.BRANCH2_APIFY_WAIT_MS)||900000;
      const until=now()+Math.max(1000,Math.min(waitMs,1200000));
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
          throw err(classifyProviderTerminal(run,lines),'Saved provider run ended '+run.status+'; automatic paid retry blocked');
        }
        if(now()>=until)throw err('apify_pending','Provider still working; saved run will be resumed');
        await sleep(5000);
      }
    })().finally(()=>active.delete(key));
    active.set(key,task);return task;
  };
}
export const resolveApifyAudio=createApifyResolver();
