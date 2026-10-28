import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { downloadVisionAudio } from './vision-audio.mjs';
import { resolveApifyAudio, isApifyConfigured } from './youtube-apify-source.js';

import { createAudioCache, audioCachePaths, verifiedAudioFile } from './youtube-audio-cache.js';

const YEMOT_API_BASE = 'https://www.call2all.co.il/ym/api';
const YEMOT_UPLOAD_URL = YEMOT_API_BASE + '/UploadFile';
const MAX_SOURCE_BYTES = 120 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = Number(process.env.YOUTUBE_AUTHORIZED_SOURCE_TIMEOUT_MS || 12000);
const FFMPEG_TIMEOUT_MS = Number(process.env.YOUTUBE_AUTHORIZED_FFMPEG_TIMEOUT_MS || 120000);
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

async function makeChunks(source, dir, signal=undefined) {
  await fs.mkdir(dir, { recursive: true });
  const pattern = path.join(dir, 'chunk-%03d.wav');
  console.info('[YouTube IVR] playback step 4: starting ffmpeg');
  await runFfmpeg([
    '-hide_banner','-loglevel','error','-y',
    '-i',source,
    '-vn','-ar','8000','-ac','1','-c:a','pcm_s16le',
    '-f','segment','-segment_time','120','-reset_timestamps','1',pattern
  ], signal);
  const names=(await fs.readdir(dir))
    .filter(n => /^chunk-\d{3}\.wav$/.test(n))
    .sort();
  if(!names.length) throw new Error('ffmpeg produced no audio chunks');
  // A WAV header alone is 44 bytes; refuse to call an empty conversion "ready".
  for (const n of names) {
    const {size} = await fs.stat(path.join(dir, n));
    if (size <= 44) throw Object.assign(new Error('ffmpeg produced an empty audio chunk'), {code: 'empty_audio'});
  }
  console.info('[YouTube IVR] playback step 5: ffmpeg finished', { chunks: names.length });
  return names.map(n=>path.join(dir,n));
}

async function uploadToYemot(filePath, remotePath) {
  const buffer=await fs.readFile(filePath);
  const url=new URL(YEMOT_UPLOAD_URL);
  url.searchParams.set('token',yemotApiKey());
  url.searchParams.set('path',remotePath);
  url.searchParams.set('convertAudio','1');
  url.searchParams.set('autoNumbering','false');
  const form=new FormData();
  form.append('file',new Blob([buffer],{type:'audio/wav'}),path.basename(filePath));
  console.info('[YouTube IVR] playback step 6: uploading to Yemot', { remotePath, bytes: buffer.length });
  const response=await fetch(url,{method:'POST',body:form,signal:AbortSignal.timeout(UPLOAD_TIMEOUT_MS)});
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

async function ensureUploadedAndVerified(filePath, remotePath) {
  const existing = await getYemotFile(remotePath).catch(() => null);
  if (yemotFileReady(existing)) {
    console.info('[YouTube IVR] cached Yemot audio verified', { remotePath });
    return;
  }

  await uploadToYemot(filePath, remotePath);

  console.info('[YouTube IVR] playback step 8: verifying Yemot file', { remotePath });
  const verified = await getYemotFile(remotePath);
  if (!yemotFileReady(verified)) {
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
async function downloadApifySource(id, output, signal, onProgress=()=>{}) {
  onProgress({stage:'provider'});
  const resolved = await resolveApifyAudio(id, process.env, {store:{read:readCacheJson,write:writeCacheJson}});
  const r = await fetch(resolved.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
  if (!r.ok || !r.body) throw Object.assign(new Error('Apify file download HTTP ' + r.status), { code: 'apify_download_http' });
  const encoding=r.headers.get('content-encoding');
  const declared=encoding&&encoding!=='identity'?NaN:Number(r.headers.get('content-length'));
  const totalBytes=Number.isFinite(declared)&&declared>0?declared:null;
  onProgress({stage:'transferring',bytes:0,totalBytes});
  const file = await fs.open(output, 'w');
  let total = 0;
  try {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) throw Object.assign(new Error('Apify source too large'), { code: 'too_large' });
      onProgress({stage:'transferring',bytes:total,totalBytes});
      await file.write(Buffer.from(value));
    }
  } finally { await file.close(); }
  if (!total) throw Object.assign(new Error('Apify source empty'), { code: 'empty' });
  if(totalBytes&&total!==totalBytes)throw Object.assign(new Error('Incomplete provider audio transfer'),{code:'apify_pending'});
  onProgress({stage:'downloaded',bytes:total,totalBytes:total});
  console.info('[YouTube IVR] apify source downloaded', { videoId: id, bytes: total, title: String(resolved.title || '').slice(0, 60) });
  return total;
}

async function build(videoId, fallbackUrl=null, signal=undefined, onProgress=()=>{}) {
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
        await downloadApifySource(id, source, signal, onProgress);
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
    const chunks=await makeChunks(source,chunksDir,signal);
    onProgress({stage:'uploading',completed:0,total:chunks.length});
    console.info('[YouTube IVR] playback step 9: uploading chunks', { videoId: id, chunks: chunks.length });
    for(let i=0;i<chunks.length;i++) {
      signal?.throwIfAborted();
      // Yemot message delimiters forbid hyphens, even inside file paths.
      // Hex preserves distinct video IDs without forbidden characters.
      const playbackPath='/2/youtubeaudio/'+Buffer.from(id,'utf8').toString('hex')+'/'+String(i+1).padStart(3,'0');
      const remote='ivr2:'+playbackPath+'.wav';
      await ensureUploadedAndVerified(chunks[i],remote);
      paths.push(playbackPath);
      onProgress({stage:'uploading',completed:i+1,total:chunks.length});
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
  const jobKey=id+(fallbackUrl?'|alternate':'');
  if(activeJobs.has(jobKey)) return activeJobs.get(jobKey);
  // The first caller's deadline signal cancels download/ffmpeg/upload so no
  // orphan work keeps running on the free instance after the call gave up.
  const report=event=>{try{options?.onProgress?.(event);}catch{ /* Progress must never interrupt audio preparation. */ }};
  const job=build(id,fallbackUrl,options?.signal,report).finally(()=>activeJobs.delete(jobKey));
  activeJobs.set(jobKey,job);
  return job;
}

// Narrow exports for the branch 2 self-test (branch2-selftest.js). They use
// the same conversion and upload code as real playback, so a passing
// self-test proves the production path, not a copy of it.
export const _pipeline = { makeChunks, uploadToYemot, yemotApiKey, YEMOT_API_BASE };
