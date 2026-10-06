import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const YEMOT_API_BASE = 'https://www.call2all.co.il/ym/api';
const YEMOT_UPLOAD_URL = YEMOT_API_BASE + '/UploadFile';
const MAX_SOURCE_BYTES = 120 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = Number(process.env.YOUTUBE_AUTHORIZED_SOURCE_TIMEOUT_MS || 12000);
const FFMPEG_TIMEOUT_MS = Number(process.env.YOUTUBE_AUTHORIZED_FFMPEG_TIMEOUT_MS || 30000);
const UPLOAD_TIMEOUT_MS = Number(process.env.YOUTUBE_AUTHORIZED_UPLOAD_TIMEOUT_MS || 20000);
const VERIFY_TIMEOUT_MS = Number(process.env.YOUTUBE_AUTHORIZED_VERIFY_TIMEOUT_MS || 8000);
const activeJobs = new Map();

function yemotApiKey() {
  const key = String(process.env.YEMOT_API_KEY || '').trim();
  if (!key) throw new Error('YEMOT_API_KEY is missing');
  return key;
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

function validateSourceUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:') throw new Error('Authorized audio source must use HTTPS');
  const allowedHosts = String(process.env.AUTHORIZED_AUDIO_HOSTS || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!allowedHosts.length) throw new Error('AUTHORIZED_AUDIO_HOSTS is not configured');
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error('Audio source host is not allowlisted');
  }
  return url;
}

async function fetchAuthorizedSource(videoId, output) {
  const id = String(videoId || '').trim();
  const mapped = await authorizedSourceFromSupabase(id) || authorizedSourceFromEnv(id);
  if (!mapped) throw new Error('No authorized audio source mapped to this video');

  const sourceUrl = validateSourceUrl(mapped);
  const response = await fetch(sourceUrl, {
    headers: { accept: 'audio/*,application/octet-stream;q=0.9,*/*;q=0.1' },
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS)
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
  return total;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg-static is unavailable'));
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, FFMPEG_TIMEOUT_MS);
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

async function makeChunks(source, dir) {
  await fs.mkdir(dir, { recursive: true });
  const pattern = path.join(dir, 'chunk-%03d.wav');
  await runFfmpeg([
    '-hide_banner','-loglevel','error','-y',
    '-i',source,
    '-vn','-ar','8000','-ac','1','-c:a','pcm_s16le',
    '-f','segment','-segment_time','120','-reset_timestamps','1',pattern
  ]);
  const names=(await fs.readdir(dir))
    .filter(n => /^chunk-\d{3}\.wav$/.test(n))
    .sort();
  if(!names.length) throw new Error('ffmpeg produced no audio chunks');
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
  const response=await fetch(url,{method:'POST',body:form,signal:AbortSignal.timeout(UPLOAD_TIMEOUT_MS)});
  const body=await response.text();
  if(!response.ok) throw new Error('Yemot UploadFile HTTP '+response.status+': '+body.slice(0,300));
  let result;
  try { result=JSON.parse(body); } catch { throw new Error('Yemot UploadFile returned invalid JSON'); }
  if(result.responseStatus && result.responseStatus!=='OK') {
    throw new Error('Yemot UploadFile failed: '+(result.message||result.responseStatus));
  }
  if(result.success===false) throw new Error('Yemot UploadFile failed');
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

async function ensureUploadedAndVerified(filePath, remotePath) {
  const existing = await getYemotFile(remotePath).catch(() => null);
  if (existing?.responseStatus === 'OK') {
    console.info('[YouTube IVR] cached Yemot audio verified', { remotePath });
    return;
  }

  await uploadToYemot(filePath, remotePath);

  const verified = await getYemotFile(remotePath);
  if (verified?.responseStatus !== 'OK') {
    throw new Error('Yemot file upload was not verified: ' + (verified?.message || 'file missing after upload'));
  }
  console.info('[YouTube IVR] Yemot audio verified', {
    remotePath,
    size: verified.size || null,
    fileType: verified.fileType || null
  });
}

async function build(videoId) {
  const id=String(videoId||'').trim();
  if(!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error('Invalid YouTube video id');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'authorized-audio-'));
  const source=path.join(temp,id+'.source');
  const chunksDir=path.join(temp,'chunks');
  const paths=[];
  try {
    await fetchAuthorizedSource(id,source);
    const chunks=await makeChunks(source,chunksDir);
    for(let i=0;i<chunks.length;i++) {
      const remote='ivr2:/2/youtube-authorized/'+id+'-'+String(i+1).padStart(3,'0')+'.wav';
      await ensureUploadedAndVerified(chunks[i],remote);
      paths.push('/2/youtube-authorized/'+id+'-'+String(i+1).padStart(3,'0'));
    }
    return {playbackPaths:paths,chunkCount:paths.length};
  } finally {
    await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});
  }
}

export async function downloadAuthorizedAudioToYemot(videoId) {
  const id=String(videoId||'').trim();
  if(activeJobs.has(id)) return activeJobs.get(id);
  const job=build(id).finally(()=>activeJobs.delete(id));
  activeJobs.set(id,job);
  return job;
}
