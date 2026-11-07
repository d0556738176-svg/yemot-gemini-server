import { createHash } from 'node:crypto';
import { playbackAwake } from './playback-awake.js';
import fs from 'node:fs/promises';
import { openAsBlob, createWriteStream, createReadStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { addCoverArt, fetchThumbnail, normalizeCover, makeDownloadCopy, downloadMetadata, inspectMedia } from './youtube-cover-art.js';
import { downloadVisionAudio } from './vision-audio.mjs';
import { resolveApifyAudio, isApifyConfigured, nativeLimits, NATIVE_ACTOR_ID } from './youtube-apify-source.js';
import { pickApifyActor } from './youtube-engine-select.js';
import { preparePhoneAudio, PHONE_AUDIO_VERSION } from './youtube-phone-audio.js';
import { publishToExt7 } from './branch2-ext7.js';

import { createAudioCache, audioCachePaths, verifiedAudioFile, titleFileName } from './youtube-audio-cache.js';

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

async function uploadToYemot(filePath, remotePath, signal=undefined, {convertAudio=true,single=false}={}) {
  // File-backed Blob: a long song is streamed from disk, never held in memory.
  const blob=await openAsBlob(filePath,{type:'audio/wav'});
  const bytes=blob.size;
  // Measured on the account (04.11): whether one big request is accepted
  // decides if parts are needed at all (see branch2-maintenance.js).
  // Measured 04.11: one request of 56MB is accepted, 85MB is refused (413);
  // the exact limit is measured once (upload_cap_v1.json). Yemot's multi-part
  // protocol always converts the joined file to its 8kHz WAV, so it is used
  // only for phone WAV files; other files above the limit are split by the
  // caller (uploadCapBytes()).
  if(!single&&bytes>await uploadCapBytes()){
    if(/\.wav$/i.test(remotePath))return uploadToYemotInParts(filePath,remotePath,signal,{convertAudio,style:'full'});
    throw Object.assign(new Error('File is larger than one Yemot upload allows'),{code:'too_large_for_yemot'});
  }
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

// Yemot accepts at most 50MB in one request (documented). Bigger files go in
// parts with Yemot's own multi-part protocol, then one "done" request joins
// them into ONE file, so even a many-hour song stays a single complete file.
let doneVariant=null;
const YEMOT_SINGLE_MAX=Math.max(1,Number(process.env.YEMOT_SINGLE_UPLOAD_MB||50))*1024*1024;
let bigSingleCache=null;
let capCache=null;
export async function uploadCapBytes(){
  if(capCache)return capCache;
  const r=await readCacheJson('ivr2:/2/selftest/upload_cap_v1.json').catch(()=>null);
  const mb=Number(r?.maxOkMb)||56;
  const cap=Math.floor((mb-1)*1024*1024);
  if(r)capCache=cap;
  return cap;
}
async function bigSingleUploadWorks(){
  if(bigSingleCache!==null)return bigSingleCache;
  const r=await readCacheJson('ivr2:/2/selftest/big_upload_v4.json').catch(()=>null);
  if(r)bigSingleCache=r.single?.oneFile===true;
  return r?.single?.oneFile===true;
}
const YEMOT_PART_BYTES = Math.max(1024*1024, Number(process.env.YEMOT_UPLOAD_PART_MB || 40) * 1024 * 1024);
// partStyle: how each part request carries its fields (measured by the
// account test, branch2-maintenance.js): 'full' = token+path+qq* in the form,
// 'nopath' = token+qq* only, 'query' = token in the URL, qq* in the form.
let partStyleCache=null;
async function partStyle(){
  if(partStyleCache)return partStyleCache;
  const r=await readCacheJson('ivr2:/2/selftest/multipart_v1.json').catch(()=>null);
  if(r?.works){partStyleCache=r.works;doneVariant=r.works.done||doneVariant;}
  return partStyleCache;
}
async function uploadToYemotInParts(filePath, remotePath, signal, {convertAudio,style=null,partBytes=YEMOT_PART_BYTES,log=null,doneConvert=undefined}={}) {
  const st=style||(await partStyle())?.part||'full';
  const blob=await openAsBlob(filePath);
  const total=blob.size, parts=Math.ceil(total/partBytes);
  // The file name Yemot gives the joined file comes from qqfilename (measured:
  // with a temp name it was saved as <path>/<temp name>/000.wav), so the parts
  // carry the final name and numbering is off ("0"; the string "false" was
  // taken as on).
  const uuid=crypto.randomUUID(), name=path.posix.basename(String(remotePath).replace(/^ivr2:/,''));
  // Measured 04.11: the joining request treats "path" as a FOLDER and saves
  // the file inside it as <name>/000.<ext>, reporting where. So the parts go
  // to a temporary folder, and the joined file is then moved to its real name.
  const finalPath=remotePath;
  remotePath='ivr2:/2/youtubejobs/upload_'+uuid.slice(0,8);
  console.info('[YouTube IVR] uploading to Yemot in parts', { remotePath, bytes: total, parts, style: st });
  for(let i=0;i<parts;i++){
    const start=i*partBytes, chunk=blob.slice(start,Math.min(total,start+partBytes));
    const form=new FormData();
    const qq={qquuid:uuid,qqpartindex:String(i),qqpartbyteoffset:String(start),qqchunksize:String(chunk.size),qqtotalparts:String(parts),
      qqtotalfilesize:String(total),qqfilename:name,uploader:'yemot-admin'};
    const fields=st==='full'?{token:yemotApiKey(),path:remotePath,convertAudio:convertAudio?'1':'0',autoNumbering:'0',...qq}
      :st==='nopath'?{token:yemotApiKey(),...qq}:qq;
    for(const [k,v] of Object.entries(fields))form.append(k,v);
    form.append('qqfile',chunk,name);
    const url=st==='query'?YEMOT_UPLOAD_URL+'?token='+encodeURIComponent(yemotApiKey()):YEMOT_UPLOAD_URL;
    const timeout=AbortSignal.timeout(Math.max(UPLOAD_TIMEOUT_MS,Math.ceil(chunk.size/250000)*1000));
    let ok=false,last='';
    for(let attempt=1;attempt<=3&&!ok;attempt++){
      const r=await fetch(url,{method:'POST',body:form,signal:signal?AbortSignal.any([signal,timeout]):timeout}).catch(e=>({ok:false,status:0,text:async()=>String(e?.message||e)}));
      last=(await r.text().catch(()=>'')).slice(0,300);
      let j=null;try{j=JSON.parse(last);}catch{}
      ok=r.ok&&(!j||j.success!==false&&(!j.responseStatus||j.responseStatus==='OK'));
    }
    if(i===0)log?.('first part answer',last.slice(0,200));
    if(i===parts-1)log?.('last part answer',last.slice(0,300));
    if(!ok)throw new Error('Yemot part upload failed ('+(i+1)+'/'+parts+'): '+last);
  }

  // The joining request: form-encoded body (how Yemot's own clients send it);
  // if Yemot does not take that, the same fields in the query string.
  const fields={token:yemotApiKey(),path:remotePath,convertAudio:convertAudio?'1':'0',autoNumbering:'0',tts:'0',
    qquuid:uuid,qqfilename:name,qqtotalfilesize:String(total),qqtotalparts:String(parts),uploader:'yemot-admin'};
  // How "no conversion" must be written in the joining request (measured by
  // the account test; '0' was still converted).
  const dc=doneConvert!==undefined?doneConvert:(await partStyle())?.convert;
  if(!convertAudio&&dc!==undefined){ if(dc===null)delete fields.convertAudio; else fields.convertAudio=dc; }
  const finishMs=Math.max(60000,Math.ceil(total/1000000)*2000);
  const q=new URLSearchParams(fields).toString();
  const mp=extra=>{const f=new FormData();for(const [k,v] of Object.entries({...fields,...extra}))f.append(k,v);return f;};
  const sig=()=>AbortSignal.timeout(finishMs);
  // Variants of the documented "UploadFile?done" request; the one that works
  // is remembered for the rest of the process.
  const tries=[
    ['urlencoded',()=>fetch(YEMOT_UPLOAD_URL+'?done',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:q,signal:sig()})],
    ['query',()=>fetch(YEMOT_UPLOAD_URL+'?done&'+q,{method:'POST',signal:sig()})],
    ['done=1 query',()=>fetch(YEMOT_UPLOAD_URL+'?done=1&'+q,{method:'POST',signal:sig()})],
    ['done field',()=>fetch(YEMOT_UPLOAD_URL+'?done',{method:'POST',body:mp({done:'1'}),signal:sig()})],
    ['GET',()=>fetch(YEMOT_UPLOAD_URL+'?done&'+q,{signal:sig()})],
    ['path done',()=>fetch(YEMOT_API_BASE+'/UploadFile/done?'+q,{method:'POST',signal:sig()})],
  ];
  if(doneVariant)tries.sort((a,b)=>(b[0]===doneVariant)-(a[0]===doneVariant));
  let result=null,body='';const seen=[];
  for(const [label,t] of tries){
    const r=await t().catch(e=>({ok:false,text:async()=>String(e?.message||e)}));
    body=await r.text();result=null;try{result=JSON.parse(body);}catch{}
    if(r.ok&&result&&result.success!==false&&(!result.responseStatus||result.responseStatus==='OK')){doneVariant=label;break;}
    seen.push(label+': '+body.slice(0,90));result=null;
  }
  if(!result)console.warn('[YouTube IVR] multi-part join answers',seen);
  if(!result)throw new Error('Yemot multi-part finish failed: '+body.slice(0,300));
  // Move the joined file from where Yemot put it to its real name.
  const joined='ivr2:/'+String(result.path||'').replace(/^ivr2?:?\/?/,'').replace(/^\/+/,'');
  const fa=async params=>{const u=new URL(YEMOT_API_BASE+'/FileAction');u.searchParams.set('token',yemotApiKey());for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);
    const r=await fetch(u,{signal:AbortSignal.timeout(60000)});return r.json().catch(()=>null);};
  await fa({action:'delete',what:finalPath}).catch(()=>null); // replace an older copy
  const mv=await fa({action:'move',what:joined,target:finalPath});
  await fa({action:'delete',what:remotePath}).catch(()=>null);
  const m=await getYemotFile(finalPath).catch(()=>null);
  const sizeOk=Number(m?.file?.size)===total||(/\.wav$/i.test(finalPath)&&Math.abs(Number(m?.file?.size)-total)<=4096);
  if(m?.file?.exists!==true||!sizeOk)
    throw new Error('Yemot multi-part file not in place: '+JSON.stringify({joined,move:mv?.responseStatus||null,size:m?.file?.size??null}).slice(0,240));
  console.info('[YouTube IVR] playback step 7: Yemot UploadFile accepted (parts joined)', { remotePath: finalPath, parts, variant: doneVariant, bytes: total });
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
async function ensureUploadedAndVerified(filePath, remotePath, { expectedDurationSec, signal, replace = false } = {}) {
  // replace: the name has no version in it, so an existing file may hold an
  // older preparation of the same video; always upload this build's audio.
  const existing = replace ? null : await getYemotFile(remotePath).catch(() => null);
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
  return { bytes: total, title: resolved.title || null };
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

// Every song downloaded from the phone is ALSO saved directly in extension 2's
// own folder (owner's choice 04.11, no sub-folder), as ONE file for
// downloading from Yemot: best quality (YouTube's own audio, not
// the phone-line version), the video's picture as cover, and all its details
// (title, channel, date, genre, description, tags, link). The folder is not a
// played extension, so it never plays on the line. Format chosen by the
// account test (m4a when Yemot keeps it intact, otherwise mp3 320k).
export const DOWNLOAD_DIR='ivr2:/2'; // before 04.11 evening; now download-folders.js (ivr2:/אודיו)
export const OLD_DOWNLOAD_DIR='ivr2:/2/הורדות_מיוטיוב';
const DOWNLOAD_OWNERS='ivr2:/2/youtubeaudio/download_owners.json';
export const DOWNLOAD_TEST_RESULT='ivr2:/2/selftest/download_copy_result_v3.json';
let downloadPolicyCache=null;
async function downloadCopyPolicy(){
  if(String(process.env.BRANCH2_DOWNLOAD_COPY||'on').toLowerCase()==='off')return null;
  if(downloadPolicyCache)return downloadPolicyCache.format?downloadPolicyCache:null;
  const r=await readCacheJson(DOWNLOAD_TEST_RESULT).catch(()=>null);
  if(!r)return null; // not tested yet: plain behaviour, ask again next song
  downloadPolicyCache={format:r.format||null};
  return downloadPolicyCache.format?downloadPolicyCache:null;
}
// Uploads one finished file, reads it back from Yemot (streamed) and checks it
// is byte-for-byte what was made; returns what a player sees in it.
async function uploadDownloadVerified(file,remote,temp){
  const bytes=(await fs.stat(file)).size;
  await uploadToYemot(file,remote,undefined,{convertAudio:false});
  const meta=await getYemotFile(remote);
  if(meta?.file?.exists!==true||Number(meta?.file?.size)!==bytes)throw new Error('download copy not verified in Yemot');
  const back=path.join(temp,'readback'+path.extname(file));
  const u=new URL(YEMOT_API_BASE+'/DownloadFile');u.searchParams.set('token',yemotApiKey());u.searchParams.set('path',remote);
  const rb=await fetch(u,{signal:AbortSignal.timeout(Math.ceil(Math.max(120000,bytes/50)))});
  if(!rb.ok)throw new Error('download copy read-back failed HTTP '+rb.status);
  await streamPipeline(Readable.fromWeb(rb.body),createWriteStream(back));
  const sha=f=>new Promise((res,rej)=>{const h=createHash('sha256');createReadStream(f).on('data',d=>h.update(d)).on('end',()=>res(h.digest('hex'))).on('error',rej);});
  const identical=(await sha(back))===(await sha(file));
  const seen=await inspectMedia(back,ffmpegPath).catch(()=>null);
  await fs.rm(back,{force:true}).catch(()=>{});
  if(!identical)throw new Error('download copy in Yemot differs from the file made');
  return {bytes,seen};
}

// The downloadable copy. Best quality that fits ONE Yemot upload (the
// account's measured request limit): lossless FLAC; if too big, M4A (AAC
// 256k, or YouTube's own AAC untouched); if even that is too big (very long
// recordings), M4A in numbered parts, each a complete file with the picture.
async function saveDownloadCopy(id,source,title,temp,policy,durationSec=null,titleSuffix=''){
  const t=Date.now();
  const { fetchVideoFacts } = await import('./youtube-video-facts.js');
  const { retrying, coverFor } = await import('./youtube-cover-art.js');
  const [facts,jpeg]=await Promise.all([
    retrying(()=>fetchVideoFacts(id,process.env),{ok:x=>!!(x&&x.title)}),
    coverFor(id,{ffmpegPath,maxWidth:1280,quality:2}),
  ]);
  if(!jpeg||!facts?.title)console.warn('[DOWNLOADS] saved with less than full details',{videoId:id,picture:!!jpeg,details:!!facts?.title});
  const metadata=downloadMetadata(id,facts||{},title);
  // A dubbed version (" - דיבוב לעברית") keeps all details, named apart.
  if(titleSuffix)metadata.title=String(metadata.title||title||id)+titleSuffix;
  const cap=await uploadCapBytes();
  let format=policy.format;
  let out=path.join(temp,'download.'+format);
  let bytes=await makeDownloadCopy(source,out,{format,jpeg,metadata,ffmpegPath});
  if(bytes>cap&&format==='flac'){
    await fs.rm(out,{force:true}).catch(()=>{});
    format='m4a';out=path.join(temp,'download.m4a');
    bytes=await makeDownloadCopy(source,out,{format,jpeg,metadata,ffmpegPath});
  }
  const files=[];
  if(bytes<=cap)files.push({file:out,suffix:'',tags:metadata});
  else{
    await fs.rm(out,{force:true}).catch(()=>{});
    const dur=Number(durationSec)||Number(facts?.durationSeconds)||0;
    if(!dur)throw new Error('download copy too large and length unknown');
    const n=Math.ceil(bytes/(cap*0.9)),seg=Math.ceil(dur/n);
    for(let k=0;k<n;k++){
      const f=path.join(temp,'part'+(k+1)+'.m4a');
      const tags={...metadata,title:metadata.title+' (חלק '+(k+1)+' מתוך '+n+')',track:(k+1)+'/'+n};
      await makeDownloadCopy(source,f,{format:'m4a',jpeg,metadata:tags,ffmpegPath,start:k*seg,length:seg});
      files.push({file:f,suffix:'',part:k+1,tags});
    }
  }
  await fs.rm(source,{force:true}).catch(()=>{});
  // Hebrew name as seen in Yemot, then the same name in English letters, which
  // is what remains when Yemot's download erases the Hebrew (owner, 06.11).
  const { titleFileName } = await import('./youtube-audio-cache.js');
  const { yemotFileName } = await import('./youtube-latin-name.js');
  const base=await yemotFileName(metadata.title||title||id,{titleFileName})||id;
  const owners=await readCacheJson(DOWNLOAD_OWNERS).catch(()=>null)||{};
  const ownerId=titleSuffix?id+'-he':id;
  const name=owners[base]&&owners[base]!==ownerId?base+'_'+id:base;
  const folders=await import('./download-folders.js');
  const saved=[];let seen=null;
  for(const x of files){
    const { withPart } = await import('./youtube-latin-name.js');
    const remote=(await folders.nextFolder('audio',{readJson:readCacheJson}))+'/'+(x.part?withPart(name,x.part):name)+x.suffix+'.'+format;
    const r=await uploadDownloadVerified(x.file,remote,temp);
    await fs.rm(x.file,{force:true}).catch(()=>{});
    await folders.countSaved('audio',{readJson:readCacheJson,writeJson:writeCacheJson});
    saved.push({remote,bytes:r.bytes});seen=seen||r.seen;
  }
  if(!owners[name]){owners[name]=ownerId;await writeCacheJson(DOWNLOAD_OWNERS,owners).catch(()=>{});}
  console.info('[DOWNLOADS] song saved for downloading',{videoId:id,files:saved,format,identicalInYemot:true,
    picture:seen?.picture??!!jpeg,pictureSize:seen?.pictureSize||null,audio:seen?.audio||null,
    title:seen?.tags?.title||null,artist:seen?.tags?.artist||null,date:seen?.tags?.date||null,genre:seen?.tags?.genre||null,
    tagCount:seen?Object.keys(seen.tags).length:null,ms:Date.now()-t});
}

// Result of the one-time account test (branch2-cover-selftest.js); read once.
let coverPolicyCache=null;
async function coverPolicy(){
  if(String(process.env.BRANCH2_COVER_ART||'on').toLowerCase()==='off')return {stored:false,convert:false};
  if(coverPolicyCache)return coverPolicyCache;
  const r=await readCacheJson('ivr2:/2/selftest/cover_result_v1.json').catch(()=>null);
  const policy={stored:r?.safeStored===true,convert:r?.safeConvert===true};
  if(r)coverPolicyCache=policy; // not tested yet: ask again next song
  return policy;
}
async function build(videoId, fallbackUrl=null, signal=undefined, onProgress=()=>{}, consent=false) {
  const id=String(videoId||'').trim();
  if(!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error('Invalid YouTube video id');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'authorized-audio-'));
  const source=path.join(temp,id+'.source');
  const chunksDir=path.join(temp,'chunks');
  const paths=[];
  let ext7Job=null, mp3Job=null;
  try {
    // Primary: Apify (downloads the full audio on their infra, bypassing the
    // datacenter block). Falls through to the older paths only if it fails.
    let apifyOk = false;
    let sourceTitle = null;
    if (isApifyConfigured(process.env)) {
      try {
        ({ title: sourceTitle } = await downloadApifySource(id, source, signal, onProgress, consent));
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
    const mastered=await preparePhoneAudio(source,phone,{signal,onPercent:percent=>onProgress({stage:'converting',percent})});
    // The original audio is kept only when a downloadable MP3 copy will be
    // made from it (after the song is ready); otherwise free the disk now.
    const mp3Policy=await downloadCopyPolicy();
    if(!mp3Policy)await fs.rm(source,{force:true}).catch(()=>{});
    // The video's YouTube picture inside the file (shown when the file is
    // downloaded from Yemot), only once the account test proved Yemot keeps
    // it and still reports the right length. Never delays or fails a song.
    const cover=await coverPolicy();
    let covered=false;
    if(cover.stored){
      onProgress({stage:'converting',percent:100});
      covered=await addCoverArt(phone,{videoId:id,title:sourceTitle,ffmpegPath});
    }
    const dir='/2/youtubeaudio/'+Buffer.from(id,'utf8').toString('hex');
    // The file is named after the original YouTube title (measured 03.11:
    // Yemot stores English and Hebrew names). The video's own folder keeps it
    // unique. BRANCH2_TITLE_FILENAMES=off returns to the technical name.
    const useTitle=String(process.env.BRANCH2_TITLE_FILENAMES||'on').toLowerCase()!=='off';
    const fullPath=dir+'/'+(useTitle&&sourceTitle?titleFileName(sourceTitle):PHONE_AUDIO_VERSION+'full');
    const singleMaxBytes=Math.max(1,Number(process.env.BRANCH2_SINGLE_FILE_MAX_MB)||1024)*1024*1024;
    let single=false;
    if(mastered.bytes<=singleMaxBytes){
      try{
        onProgress({stage:'uploading',completed:0,total:1});
        const t=Date.now();
        await ensureUploadedAndVerified(phone,'ivr2:'+fullPath+'.wav',{expectedDurationSec:mastered.durationSec,signal,replace:true});
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
    // Extension 7 (newest songs first): copy the complete song there in the
    // background, AFTER it is ready here, so playback is never delayed.
    if(single&&String(process.env.BRANCH2_EXT7||'on').toLowerCase()!=='off'){
      ext7Job=publishToExt7(id,phone,sourceTitle,{readJson:readCacheJson,writeJson:writeCacheJson,
        upload:(file,remote)=>uploadToYemot(file,remote,undefined,{convertAudio:!(covered&&!cover.convert)}),log:console})
        .catch(e=>console.warn('[EXT7] song not added',{videoId:id,message:String(e?.message||e).slice(0,200)}));
    }
    // Downloadable copy with the video's picture, in the background.
    if(mp3Policy)mp3Job=saveDownloadCopy(id,source,sourceTitle,temp,mp3Policy,mastered.durationSec)
      .catch(e=>console.warn('[DOWNLOADS] song not saved for downloading',{videoId:id,message:String(e?.message||e).slice(0,200)}));
    return {playbackPaths:paths,chunkCount:paths.length};
  } finally {
    // The temporary copy is removed only after the background copies finish.
    const cleanup=()=>fs.rm(temp,{recursive:true,force:true}).catch(()=>{});
    const pending=[ext7Job,mp3Job].filter(Boolean);
    if(pending.length) void Promise.allSettled(pending).finally(cleanup); else await cleanup();
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
export const _pipeline = { uploadToYemotInParts, lastDoneVariant: () => doneVariant, makeChunks, uploadToYemot, yemotApiKey, YEMOT_API_BASE, ensureUploadedAndVerified, getYemotFile, transferProviderFile, readCacheJson, writeCacheJson, downloadApifySource, preparePhoneAudio, saveDownloadCopy, downloadCopyPolicy };




