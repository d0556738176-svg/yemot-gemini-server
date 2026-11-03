import { createHash } from 'node:crypto';
import { playbackAwake } from './playback-awake.js';
import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { downloadVisionAudio } from './vision-audio.mjs';
import { resolveApifyAudio, isApifyConfigured, nativeLimits, NATIVE_ACTOR_ID } from './youtube-apify-source.js';
import { pickApifyActor } from './youtube-engine-select.js';
import { preparePhoneAudio, PHONE_AUDIO_VERSION } from './youtube-phone-audio.js';

import { createAudioCache, audioCachePaths, verifiedAudioFile } from './youtube-audio-cache.js';

const YEMOT_API_BASE = 'https://www.call2all.co.il/ym/api';
const YEMOT_UPLOAD_URL = YEMOT_API_BASE + '/UploadFile';
// Native audio of a 12-hour video is ~690MB at YouTube's standard m4a rate.
// Kept in step with the provider's maxMegabytes (nativeLimits) so a file the
// provider accepts is never rejected here.
const MAX_SOURCE_BYTES = nativeLimits(process.env).maxMegabytes * 1024 * 1024;
// A 700MB file over a slow route needs more than the old 10 minutes.
const TRANSFER_TIMEOUT_MS = Number(process.env.BRANCH2_TRANSFER_TIMEOUT_MS || 3600000);
const SOURCE_TIMEOUT_MS = Number(process.env.YOUTUBE_AUTHORIZED_SOURCE_TIMEOUT_MS || 12000);
// A hung ffmpeg is still stopped, but a genuine 12-hour conversion (paced by
// overlapped uploads on the free CPU) must be allowed to finish.
const FFMPEG_TIMEOUT_MS = Number(process.env.YOUTUBE_AUTHORIZED_FFMPEG_TIMEOUT_MS || 10800000);
const UPLOAD_TIMEOUT_MS = Number(process.env.YOUTUBE_AUTHORIZED_UPLOAD_TIMEOUT_MS || 20000);
const VERIFY_TIMEOUT_MS = Number(process.env.YOUTUBE_AUTHORIZED_VERIFY_TIMEOUT_MS || 8000);
const activeJobs = new Map();

function yemotApiKey() {
  const key = String(process.env.YEMOT_API_KEY || '').trim();
  if (key) return key;

  // Yemot accepts username:password as the token value. Reuse the same
  // credentials as the automatic IVR configuration so branch 2 does not
  // require a duplicate secret.
  const username = String(process.env.YEMOT_API_USERNAME || '').trim();
  const password = String(process.env.YEMOT_API_PASSWORD || '').trim();
  if (username && password) return username + ':' + password;

  throw new Error('Yemot credentials are missing');
}

async function authorizedSourceFromSupabase(videoId) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_KEY || '').trim();
  if (!base || !key) return null;
  const url = new URL(base + '/rest/v1/authorized_audio_sources');
  url.searchParams.set('select', 'source_url');
  url.searchParams.set('video_id', 'eq.' + String(videoId || '').trim());
  url.searchParams.set('enabled', 'eq.true');
  const response = await fetch(url, {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Authorized source registry HTTP ' + response.status);
  const rows = await response.json();
  return rows?.[0]?.source_url || null;
}

function authorizedSourceFromEnv(videoId) {
  const raw = String(process.env.AUTHORIZED_AUDIO_SOURCES_JSON || '').trim();
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('AUTHORIZED_AUDIO_SOURCES_JSON is invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AUTHORIZED_AUDIO_SOURCES_JSON must be an object');
  }
  const entry = parsed[String(videoId || '').trim()];
  return typeof entry === 'string' ? entry : entry?.url || null;
}

function validateSourceUrl(value, dynamicAllowedHost='') {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:') throw new Error('Authorized audio source must use HTTPS');
  const allowedHosts = String(process.env.AUTHORIZED_AUDIO_HOSTS || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const dynamicHost=String(dynamicAllowedHost||'').trim().toLowerCase();
  if (!allowedHosts.length && !dynamicHost) throw new Error('AUTHORIZED_AUDIO_HOSTS is not configured');
  if (!allowedHosts.includes(url.hostname.toLowerCase()) && url.hostname.toLowerCase()!==dynamicHost) {
    throw new Error('Audio source host is not allowlisted');
  }
  return url;
}

async function fetchAuthorizedSource(videoId, output, fallbackUrl=null, signal=undefined) {
  const id = String(videoId || '').trim();
  console.info('[YouTube IVR] playback step 1: looking up authorized source', { videoId: id });
  const registrySource = await authorizedSourceFromSupabase(id) || authorizedSourceFromEnv(id);
  const mapped = registrySource || fallbackUrl;
  if (!mapped) {
    console.warn('[YouTube IVR] playback stopped: no authorized source mapping', { videoId: id });
    throw Object.assign(new Error('No authorized audio source mapped to this video'), {code: 'no_alternate_source'});
  }
  console.info('[YouTube IVR] playback step 2: authorized source found', { videoId: id, host: new URL(mapped).hostname });

  // Configured registry sources stay restricted to AUTHORIZED_AUDIO_HOSTS.
  // A publisher RSS fallback was already discovered from that publisher's
  // public feed; allow only the exact host of that one resolved enclosure.
  const dynamicAllowedHost = !registrySource && fallbackUrl ? new URL(fallbackUrl).hostname : '';
  const sourceUrl = validateSourceUrl(mapped, dynamicAllowedHost);
  const response = await fetch(sourceUrl, {
    headers: { accept: 'audio/*,application/octet-stream;q=0.9,*/*;q=0.1' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SOURCE_TIMEOUT_MS)]) : AbortSignal.timeout(SOURCE_TIMEOUT_MS)
  });
  if (!response.ok || !response.body) {
    throw new Error('Authorized audio source HTTP ' + response.status);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_SOURCE_BYTES) throw new Error('Authorized audio source is too large');

  const file = await fs.open(output, 'w');
  let total = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) throw new Error('Authorized audio source is too large');
      await file.write(Buffer.from(value));
    }
  } finally {
    await file.close();
  }
  if (!total) throw new Error('Authorized audio source is empty');
  console.info('[YouTube IVR] playback step 3: source downloaded', { videoId: id, bytes: total });
  return total;
}

function runFfmpeg(args, signal=undefined) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg-static is unavailable'));
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, FFMPEG_TIMEOUT_MS);
    // Stop the child process when the caller's budget is gone so no orphan
    // conversion keeps eating CPU on the free instance.
    const onAbort = () => { child.kill('SIGKILL'); clearTimeout(timer); reject(Object.assign(new Error('ffmpeg aborted'), {code: 'aborted'})); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 5000) stderr = stderr.slice(-5000);
    });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); code === 0
      ? resolve()
      : reject(new Error('ffmpeg failed (' + code + '): ' + stderr.slice(-1800))); });
  });
}

async function makeChunks(source, dir, signal=undefined, onChunk=undefined) {
  await fs.mkdir(dir,{recursive:true});
  const pattern=path.join(dir,'chunk-%03d.wav');
  const stop=new AbortController();
  const combined=signal?AbortSignal.any([signal,stop.signal]):stop.signal;
  let done=false,failure;
  const produced=new Set();
  const files=[];
  const list=async()=>(await fs.readdir(dir)).filter(n=>/^chunk-\d{3,}\.wav$/.test(n))
    .sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  console.info('[YouTube IVR] playback step 4: starting ffmpeg');
  const conversion=runFfmpeg([
    '-nostdin','-hide_banner','-loglevel','error','-xerror','-y','-i',source,
    '-vn','-ar','8000','-ac','1','-c:a','pcm_s16le',
    '-f','segment','-segment_time','120','-reset_timestamps','1',pattern
  ],combined).then(()=>{done=true;},e=>{failure=e;done=true;});
  try {
    for(;;){
      combined.throwIfAborted();
      if(failure)throw failure;
      const names=await list();
      // FFmpeg finalizes the WAV header before opening the NEXT segment.
      // Never read/upload the active final file until conversion exits cleanly.
      const eligible=done?names:names.slice(0,-1);
      for(const name of eligible){
        if(produced.has(name))continue;
        const index=Number(name.match(/\d+/)[0]);
        if(index!==files.length)throw new Error('Non-contiguous audio segment sequence');
        const file=path.join(dir,name);
        if((await fs.stat(file)).size<=44)throw Object.assign(new Error('Empty audio chunk'),{code:'empty_audio'});
        if(onChunk)await onChunk(file,index,{converting:!done,total:done?files.length+eligible.filter(n=>!produced.has(n)).length:null});
        produced.add(name);files.push(file);
        // Once a piece is uploaded and verified it lives in Yemot; removing the
        // local copy keeps disk use at ~2 pieces, so any length fits the free disk.
        if(onChunk)await fs.rm(file,{force:true}).catch(()=>{});
      }
      if(done){
        if(failure)throw failure;
        // A new segment may have appeared between the listing and process exit.
        if((await list()).every(n=>produced.has(n)))break;
        continue;
      }
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    if(!files.length)throw new Error('ffmpeg produced no audio chunks');
    console.info('[YouTube IVR] playback step 5: ffmpeg finished',{chunks:files.length,overlappedUpload:Boolean(onChunk)});
    return files;
  } finally {
    if(!done)stop.abort();
    await conversion;
  }
}

async function uploadToYemot(filePath, remotePath, signal=undefined, {convertAudio=true}={}) {
  // File-backed Blob: a long song is streamed from disk, never held in memory.
  const blob=await openAsBlob(filePath,{type:'audio/wav'});
  const bytes=blob.size;
  // ~250KB/s worst case, never less than the normal short-file timeout.
  const timeoutMs=Math.max(UPLOAD_TIMEOUT_MS,Math.ceil(bytes/250000)*1000);
  const url=new URL(YEMOT_UPLOAD_URL);
  url.searchParams.set('token',yemotApiKey());
  url.searchParams.set('path',remotePath);
  url.searchParams.set('convertAudio',convertAudio?'1':'0');
  url.searchParams.set('autoNumbering','false');
  const form=new FormData();
  form.append('file',blob,path.basename(filePath));
  console.info('[YouTube IVR] playback step 6: uploading to Yemot', { remotePath, bytes, timeoutMs });
  const timeout=AbortSignal.timeout(timeoutMs);
  const response=await fetch(url,{method:'POST',body:form,signal:signal?AbortSignal.any([signal,timeout]):timeout});
  const body=await response.text();
  if(!response.ok) throw new Error('Yemot UploadFile HTTP '+response.status+': '+body.slice(0,300));
  let result;
  try { result=JSON.parse(body); } catch { throw new Error('Yemot UploadFile returned invalid JSON'); }
  if(result.responseStatus && result.responseStatus!=='OK') {
    throw new Error('Yemot UploadFile failed: '+(result.message||result.responseStatus));
  }
  if(result.success===false) throw new Error('Yemot UploadFile failed');
  console.info('[YouTube IVR] playback step 7: Yemot UploadFile accepted', { remotePath, convertedSize: result.convertedSize || null, duration: result.duration || null });
  return result;
}

async function getYemotFile(remotePath) {
  const url = new URL(YEMOT_API_BASE + '/GetFile');
  url.searchParams.set('token', yemotApiKey());
  url.searchParams.set('what', remotePath);
  const response = await fetch(url, { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { data = null; }
  if (!response.ok) throw new Error('Yemot GetFile HTTP ' + response.status);
  return data;
}

// Measured on the real account (self-test 28.10): an existing file returns
// responseStatus 'OK' with file.exists=true and its size; a missing file
// returns responseStatus 'ERROR'. Require all three, not the status alone.
function yemotFileReady(data) {
  return verifiedAudioFile(data);
}

// A full-length file must also have the full duration in Yemot; a shorter one
// (interrupted earlier upload) is uploaded again instead of being trusted.
function durationMatches(data, expectedDurationSec) {
  if (!Number.isFinite(expectedDurationSec)) return true;
  const d = Number(data?.file?.duration);
  return Number.isFinite(d) ? Math.abs(d - expectedDurationSec) <= Math.max(2, expectedDurationSec * 0.01) : true;
}
async function ensureUploadedAndVerified(filePath, remotePath, { expectedDurationSec, signal } = {}) {
  const existing = await getYemotFile(remotePath).catch(() => null);
  if (yemotFileReady(existing) && durationMatches(existing, expectedDurationSec)) {
    console.info('[YouTube IVR] cached Yemot audio verified', { remotePath });
    return;
  }

  await uploadToYemot(filePath, remotePath, signal);

  console.info('[YouTube IVR] playback step 8: verifying Yemot file', { remotePath });
  const verified = await getYemotFile(remotePath);
  if (!yemotFileReady(verified) || !durationMatches(verified, expectedDurationSec)) {
    throw new Error('Yemot file upload was not verified: ' + (verified?.message || 'file missing after upload'));
  }
  console.info('[YouTube IVR] Yemot audio verified', {
    remotePath,
    size: verified.file?.size ?? null,
    duration: verified.file?.duration ?? null
  });
}


async function readCacheJson(remotePath) {
  const meta=await getYemotFile(remotePath);
  if (meta?.file?.exists===false || meta?.responseStatus==='ERROR' && /not.?found|not.?exist|doesn.t exist|לא קיים|אינו קיים|לא נמצא|לא נמצאה/i.test(String(meta.message||''))) return null;
  // Never spend a download credit when cache storage is temporarily unavailable.
  if (meta?.responseStatus!=='OK' || meta?.file?.exists!==true)
    throw Object.assign(new Error('Cannot verify audio cache storage'),{code:'cache_unavailable'});
  const url=new URL(YEMOT_API_BASE+'/DownloadFile');
  url.searchParams.set('token',yemotApiKey());
  url.searchParams.set('path',remotePath);
  const r=await fetch(url,{signal:AbortSignal.timeout(VERIFY_TIMEOUT_MS)});
  if (!r.ok) throw Object.assign(new Error('Cannot read audio cache receipt'),{code:'cache_unavailable'});
  const text=await r.text();
  if(text.length>1024*1024) throw Object.assign(new Error('Audio cache receipt too large'),{code:'cache_invalid'});
  try {return JSON.parse(text);} catch {throw Object.assign(new Error('Audio cache receipt is not JSON'),{code:'cache_invalid'});}
}
async function writeCacheJson(remotePath,data) {
  const url=new URL(YEMOT_UPLOAD_URL);
  url.searchParams.set('token',yemotApiKey());
  url.searchParams.set('path',remotePath);
  url.searchParams.set('convertAudio','0');
  url.searchParams.set('autoNumbering','false');
  const text=JSON.stringify(data);
  const form=new FormData();
  form.append('file',new Blob([text],{type:'application/json'}),'complete.json');
  const r=await fetch(url,{method:'POST',body:form,signal:AbortSignal.timeout(UPLOAD_TIMEOUT_MS)});
  const result=await r.json().catch(()=>null);
  if(!r.ok||result?.responseStatus!=='OK')
    throw Object.assign(new Error('Cannot persist audio completion receipt'),{code:'cache_write_failed'});
  const saved=await readCacheJson(remotePath);
  if(JSON.stringify(saved)!==text) throw Object.assign(new Error('Audio receipt readback mismatch'),{code:'cache_write_failed'});
}
const audioCache=createAudioCache({getFile:getYemotFile,readJson:readCacheJson,writeJson:writeCacheJson});

// One legacy full download is established by the actual 2026-10-28 15:27 UTC
// completion logs: four verified WAVs, sizes below. No general inference of
// completeness from a partial folder listing. Copy only these verified files.
const legacyCompleteDownloads={
  '0D2MvNWOVk0':[1920446,1920078,1920078,1256780]
};
export const saveCachedYouTubeAudio=(id,paths)=>audioCache.save(id,paths);

// Pending-jobs index in Yemot: the set of videoIds whose download has started
// but not yet completed. It lets the server resume interrupted downloads on
// boot (after a restart/deploy/crash) with no second phone call, so a long
// download finishes and is saved on its own. Read-modify-writes are serialized.
const PENDING_INDEX_PATH='ivr2:/2/youtubejobs/pending.json';
let pendingIndexChain=Promise.resolve();
function mutatePendingIndex(apply){
  pendingIndexChain=pendingIndexChain.then(async()=>{
    let idx=null;
    try{ idx=await readCacheJson(PENDING_INDEX_PATH); }catch{ idx=null; }
    const ids=Array.isArray(idx?.videoIds)?idx.videoIds.filter(x=>/^[A-Za-z0-9_-]{11}$/.test(x)):[];
    const set=new Set(ids);
    apply(set);
    const arr=[...set].slice(0,200);
    if(arr.length===ids.length && arr.every(x=>set.has(x)) && ids.every(x=>set.has(x))) return; // no change
    try{ await writeCacheJson(PENDING_INDEX_PATH,{version:1,videoIds:arr,updatedAt:new Date().toISOString()}); }catch{}
  }).catch(()=>{});
  return pendingIndexChain;
}
export function addPendingPlaybackJob(videoId){
  const id=String(videoId||'').trim();
  if(!/^[A-Za-z0-9_-]{11}$/.test(id)) return Promise.resolve();
  return mutatePendingIndex(set=>set.add(id));
}
export function removePendingPlaybackJob(videoId){
  const id=String(videoId||'').trim();
  if(!/^[A-Za-z0-9_-]{11}$/.test(id)) return Promise.resolve();
  return mutatePendingIndex(set=>set.delete(id));
}
export async function listPendingPlaybackJobs(){
  try{
    const idx=await readCacheJson(PENDING_INDEX_PATH);
    return Array.isArray(idx?.videoIds)?idx.videoIds.filter(x=>/^[A-Za-z0-9_-]{11}$/.test(x)):[];
  }catch{ return []; }
}

const cacheLookups=new Map();
export function lookupCachedYouTubeAudio(videoId) {
  const id=String(videoId||'').trim();
  if(cacheLookups.has(id)) return cacheLookups.get(id);
  const job=(async()=>{
    const existing=await audioCache.lookup(id);
    if(existing) return existing;
    const sizes=legacyCompleteDownloads[id];
    if(!sizes) return null;
    const paths=audioCachePaths(id,sizes.length);
    // First see if a previous call already uploaded the new safe file names.
    let safeComplete=true;
    for(let i=0;i<paths.length;i++){
      const meta=await getYemotFile('ivr2:'+paths[i]+'.wav');
      if(!verifiedAudioFile(meta)||Number(meta.file.size)!==sizes[i]){safeComplete=false;break;}
    }
    if(!safeComplete) {
      // Verify ALL old chunks before copying anything.
      for(let i=0;i<sizes.length;i++){
        const old='ivr2:/2/youtube-authorized/'+id+'-'+String(i+1).padStart(3,'0')+'.wav';
        const meta=await getYemotFile(old);
        if(!verifiedAudioFile(meta)||Number(meta.file.size)!==sizes[i])
          throw Object.assign(new Error('Legacy saved audio cannot be verified; download not attempted'),{code:'cache_incomplete'});
      }
      const temp=await fs.mkdtemp(path.join(os.tmpdir(),'audio-cache-copy-'));
      try {
        for(let i=0;i<sizes.length;i++){
          const old='ivr2:/2/youtube-authorized/'+id+'-'+String(i+1).padStart(3,'0')+'.wav';
          const url=new URL(YEMOT_API_BASE+'/DownloadFile');
          url.searchParams.set('token',yemotApiKey());url.searchParams.set('path',old);
          const r=await fetch(url,{signal:AbortSignal.timeout(UPLOAD_TIMEOUT_MS)});
          if(!r.ok) throw Object.assign(new Error('Saved audio copy failed'),{code:'cache_unavailable'});
          const b=Buffer.from(await r.arrayBuffer());
          if(b.length!==sizes[i]||b.subarray(0,4).toString()!=='RIFF')
            throw Object.assign(new Error('Saved WAV copy is invalid'),{code:'cache_invalid'});
          const local=path.join(temp,String(i)+'.wav');
          await fs.writeFile(local,b);
          await ensureUploadedAndVerified(local,'ivr2:'+paths[i]+'.wav');
        }
      } finally {await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});}
    }
    await audioCache.save(id,paths);
    console.info('[YouTube IVR] legacy saved audio recovered',{videoId:id,chunks:paths.length,downloadSkipped:true});
    return audioCache.lookup(id);
  })().finally(()=>cacheLookups.delete(id));
  cacheLookups.set(id,job);
  return job;
}

// Apify is the primary source when configured: the actor downloads the full
// audio on Apify's residential-proxy infrastructure and stores the file, which
// we then fetch here. This is what bypasses YouTube's datacenter-IP block.
async function downloadApifySource(id, output, signal, onProgress=()=>{}, consent=false) {
  onProgress({stage:'provider'});
  // Native johnvc audio is the primary engine for every length; the backup
  // engine is used only with the caller's consent. An existing run receipt
  // keeps its own actor, so this only steers NEW runs.
  const choice = await pickApifyActor(id, process.env).catch(() => ({ actor: undefined, fallback: undefined, seconds: null, reason: 'error' }));
  console.info('[YouTube IVR] engine choice', { videoId: id, engine: choice.actor || 'default', fallback: choice.fallback || null, lengthSec: choice.seconds ?? null, reason: choice.reason, consent });
  const resolved = await resolveApifyAudio(id, process.env, {store:{read:readCacheJson,write:writeCacheJson}, actor:choice.actor, fallbackActor:choice.fallback, consentToFallback:consent,signal,onProgress});
  // The provider file stays stored after the run, so a broken transfer is
  // fetched again from the same link: no new run and no new charge.
  const native=resolved.actorId===NATIVE_ACTOR_ID;
  const expectedBytes=native?resolved.item.fileSizeBytes:null;
  if(expectedBytes>MAX_SOURCE_BYTES) throw Object.assign(new Error('Source exceeds supported audio size'),{code:'too_large'});
  let total=0;
  for(let attempt=1;;attempt++){
    try{
      total=await transferProviderFile(resolved,output,signal,onProgress,expectedBytes);
      break;
    }catch(e){
      const retryable=e?.code==='transfer_incomplete'||e?.code==='apify_invalid_result'||e?.code==='apify_download_http'||e?.name==='TimeoutError'||e?.name==='TypeError';
      if(signal?.aborted||!retryable||attempt>=2){
        if(e?.code==='transfer_incomplete')e.code='apify_pending';
        throw e;
      }
      console.warn('[YouTube IVR] provider file transfer failed; fetching the stored file again',{videoId:id,attempt,code:e?.code||e?.name||'unknown'});
    }
  }
  onProgress({stage:'downloaded',bytes:total,totalBytes:total});
  console.info('[YouTube IVR] apify source downloaded', { videoId: id, bytes: total, title: String(resolved.title || '').slice(0, 60) });
  return total;
}

// Streams one stored provider file to disk, verifying length and (for native
// audio) the provider's SHA-256 so a damaged file never reaches the caller.
async function transferProviderFile(resolved,output,signal,onProgress,expectedBytes){
  const r = await fetch(resolved.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)]) : AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
  if (!r.ok || !r.body) throw Object.assign(new Error('Apify file download HTTP ' + r.status), { code: 'apify_download_http' });
  const encoding=r.headers.get('content-encoding');
  const declared=encoding&&encoding!=='identity'?NaN:Number(r.headers.get('content-length'));
  const totalBytes=Number.isFinite(declared)&&declared>0?declared:expectedBytes||null;
  if(totalBytes>MAX_SOURCE_BYTES) {
    await r.body.cancel().catch(()=>{});
    throw Object.assign(new Error('Source exceeds supported audio size'),{code:'too_large'});
  }
  onProgress({stage:'transferring',bytes:0,totalBytes});
  const file = await fs.open(output, 'w');
  let total = 0;
  const digest=createHash('sha256');
  try {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      digest.update(value);
      if (total > MAX_SOURCE_BYTES) throw Object.assign(new Error('Apify source too large'), { code: 'too_large' });
      onProgress({stage:'transferring',bytes:total,totalBytes});
      await file.write(Buffer.from(value));
    }
  } finally { await file.close(); }
  if (!total) throw Object.assign(new Error('Apify source empty'), { code: 'transfer_incomplete' });
  if(totalBytes&&total!==totalBytes)throw Object.assign(new Error('Incomplete provider audio transfer'),{code:'transfer_incomplete'});
  if(resolved.actorId===NATIVE_ACTOR_ID&&digest.digest('hex')!==String(resolved.item.sha256).toLowerCase())
    throw Object.assign(new Error('Provider file checksum mismatch'),{code:'apify_invalid_result'});
  return total;
}

async function build(videoId, fallbackUrl=null, signal=undefined, onProgress=()=>{}, consent=false) {
  const id=String(videoId||'').trim();
  if(!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error('Invalid YouTube video id');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'authorized-audio-'));
  const source=path.join(temp,id+'.source');
  const chunksDir=path.join(temp,'chunks');
  const paths=[];
  try {
    // Primary: Apify (downloads the full audio on their infra, bypassing the
    // datacenter block). Falls through to the older paths only if it fails.
    let apifyOk = false;
    if (isApifyConfigured(process.env)) {
      try {
        await downloadApifySource(id, source, signal, onProgress, consent);
        apifyOk = true;
      } catch (apifyError) {
        console.warn('[YouTube IVR] provider preparation stopped; no second download attempted', { videoId: id, code: apifyError?.code || 'apify_pending' });
        throw apifyError;
      }
    }
    if (!apifyOk && process.env.YOUTUBE_VISIONOS_EXPERIMENT !== 'false') {
      try {
        const {bytes} = await downloadVisionAudio(id, source, {signal});
        console.info('[YouTube IVR] vision audio downloaded', {videoId: id, bytes});
      } catch (error) {
        console.warn('[YouTube IVR] vision audio unavailable; trying existing source', {videoId: id, code: error?.code || 'unknown', error: String(error?.message || '').slice(0,150)});
        try {
          await fetchAuthorizedSource(id,source,fallbackUrl,signal);
        } catch (fallbackError) {
          // Report the original YouTube refusal when no other source exists;
          // "no mapping" alone would hide the real reason from the caller and logs.
          if (fallbackError?.code === 'no_alternate_source') {
            throw Object.assign(new Error('YouTube audio unavailable: ' + (error?.code || 'unknown')), {code: error?.code || 'youtube_unavailable', cause: error});
          }
          throw fallbackError;
        }
      }
    } else if (!apifyOk) {
      await fetchAuthorizedSource(id,source,fallbackUrl,signal);
    }
    signal?.throwIfAborted();
    onProgress({stage:'converting'});
    // Master the whole song for the phone line once (level, clarity, no
    // clipping), then upload it to Yemot as ONE complete file.
    const phone=path.join(temp,'phone.wav');
    const mastered=await preparePhoneAudio(source,phone,{signal});
    await fs.rm(source,{force:true}).catch(()=>{}); // free disk before upload
    const dir='/2/youtubeaudio/'+Buffer.from(id,'utf8').toString('hex');
    const fullPath=dir+'/'+PHONE_AUDIO_VERSION+'full';
    const singleMaxBytes=Math.max(1,Number(process.env.BRANCH2_SINGLE_FILE_MAX_MB)||1024)*1024*1024;
    let single=false;
    if(mastered.bytes<=singleMaxBytes){
      try{
        onProgress({stage:'uploading',completed:0,total:1});
        const t=Date.now();
        await ensureUploadedAndVerified(phone,'ivr2:'+fullPath+'.wav',{expectedDurationSec:mastered.durationSec,signal});
        paths.push(fullPath);single=true;
        console.info('[YouTube IVR] single full file uploaded',{videoId:id,bytes:mastered.bytes,durationSec:mastered.durationSec,uploadMs:Date.now()-t});
      }catch(e){
        if(signal?.aborted)throw e;
        console.warn('[YouTube IVR] single full file not accepted; uploading in pieces instead',{videoId:id,bytes:mastered.bytes,error:String(e?.message||e).slice(0,200)});
      }
    }
    if(!single){
      // Same mastered audio, split only because Yemot refused the full file.
      await makeChunks(phone,chunksDir,signal,async(file,index,info)=>{
        signal?.throwIfAborted();
        const playbackPath=dir+'/'+PHONE_AUDIO_VERSION+'_'+String(index+1).padStart(3,'0');
        await ensureUploadedAndVerified(file,'ivr2:'+playbackPath+'.wav',{signal});
        paths.push(playbackPath);
        onProgress({stage:info.converting?'preparing':'uploading',completed:paths.length,total:info.total});
      });
    }
    onProgress({stage:'verifying',completed:paths.length,total:paths.length});
    await audioCache.save(id,paths);
    return {playbackPaths:paths,chunkCount:paths.length};
  } finally {
    await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});
  }
}

export async function downloadAuthorizedAudioToYemot(videoId, options={}) {
  const id=String(videoId||'').trim();
  const fallbackUrl=String(options?.fallbackUrl||'').trim()||null;
  const consent=options?.consentToFallback?true:false;
  const jobKey=id+(fallbackUrl?'|alternate':'')+(consent?'|consent':'');
  if(activeJobs.has(jobKey)) return activeJobs.get(jobKey);
  // The first caller's deadline signal cancels download/ffmpeg/upload so no
  // orphan work keeps running on the free instance after the call gave up.
  const report=event=>{try{options?.onProgress?.(event);}catch{ /* Progress must never interrupt audio preparation. */ }};
  const releaseAwake=playbackAwake.acquire();
  const job=build(id,fallbackUrl,options?.signal,report,consent).finally(()=>{
    activeJobs.delete(jobKey);
    releaseAwake();
  });
  activeJobs.set(jobKey,job);
  return job;
}

// Narrow exports for the branch 2 self-test (branch2-selftest.js). They use
// the same conversion and upload code as real playback, so a passing
// self-test proves the production path, not a copy of it.
export const _pipeline = { makeChunks, uploadToYemot, yemotApiKey, YEMOT_API_BASE, ensureUploadedAndVerified, getYemotFile, transferProviderFile, readCacheJson, writeCacheJson };




