import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function safeMediaUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      !(u.hostname === 'googlevideo.com' || u.hostname.endsWith('.googlevideo.com'))) {
    throw new Error('UNAPPROVED_MEDIA_HOST');
  }
  return u;
}
export function isAudio(bytes, mime) {
  if (/html|json|text\//i.test(mime)) return false;
  const head = bytes.subarray(0, 100).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<') || head.startsWith('{')) return false;
  return bytes.subarray(4,8).toString() === 'ftyp' ||
    bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
}

async function fetchMedia(url) {
  const trace = [];
  let target = safeMediaUrl(url);
  const signal = AbortSignal.timeout(30000);
  for (let i = 0; i < 6; i++) {
    const res = await fetch(target, { redirect: 'manual', signal });
    const mime = res.headers.get('content-type') || '';
    trace.push({ host: target.hostname, status: res.status, mime });
    if ([301,302,303,307,308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new Error('REDIRECT_WITHOUT_LOCATION');
      target = safeMediaUrl(new URL(location, target).href); continue;
    }
    if (!res.ok) { await res.body?.cancel(); return { error: 'MEDIA_HTTP_ERROR', trace }; }
    if (Number(res.headers.get('content-length')) > 8*1024*1024) {
      await res.body?.cancel(); return { error: 'MEDIA_TOO_LARGE', trace };
    }
    const parts = []; let total = 0;
    if (!res.body) return { error: 'EMPTY_MEDIA', trace };
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 8*1024*1024) { await reader.cancel(); return { error: 'MEDIA_TOO_LARGE', trace }; }
      parts.push(value);
      if (parts.length === 1 && /html|json|text\//i.test(mime)) {
        await reader.cancel(); return { error: 'NON_AUDIO_RESPONSE', trace, bytes: total };
      }
    }
    const data = Buffer.concat(parts);
    if (!isAudio(data, mime)) return { error: 'INVALID_AUDIO_SIGNATURE', trace, bytes: total };
    return { data, trace, bytes: total };
  }
  return { error: 'TOO_MANY_REDIRECTS', trace };
}

async function convert(input, output) {
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin','-v','error','-y','-i',input,'-t','8','-vn',
      '-ar','8000','-ac','1','-c:a','pcm_s16le',output], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('FFMPEG_UNAVAILABLE')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('AUDIO_DECODE_FAILED')); });
  });
  const b = await readFile(output);
  if (b.subarray(0,4).toString() !== 'RIFF' || b.length < 16000) throw new Error('INVALID_WAV');
  return { bytes: b.length, sampleRate: 8000, channels: 1, encoding: 'pcm_s16le', maxSeconds: 8 };
}

export async function probe() {
  if (!process.env.RAPIDAPI_KEY) return { stage: 'configuration', error: 'MISSING_RAPIDAPI_KEY' };
  const api = new URL('https://ytstream-download-youtube-videos.p.rapidapi.com/dl');
  api.searchParams.set('id', 'UxxajLWwzqY');
  if (process.env.PROBE_GEO) api.searchParams.set('cgeo', process.env.PROBE_GEO);
  const res = await fetch(api, { headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
    'X-RapidAPI-Host': api.hostname }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) { await res.body?.cancel(); return { stage: 'api', http: res.status }; }
  const j = await res.json();
  if (j.status !== 'OK') return { stage: 'api', http: res.status, error: 'PROVIDER_STATUS_NOT_OK' };
  const formats = (j.adaptiveFormats || []).filter(x => /^audio\//.test(x.mimeType || '') && x.url)
    .sort((a,b) => (a.itag===140 ? -1 : b.itag===140 ? 1 : 0));
  const provider = { isProxied: j.isProxied, geoMode: process.env.PROBE_GEO || 'provider_auto',
    mediaHosts: [...new Set(formats.map(x => new URL(x.url).hostname))] };
  const attempts = [];
  const dir = await mkdtemp(join(tmpdir(), 'ytstream-probe-'));
  try {
    for (const format of formats.slice(0,2)) {
      let media;
      try { media = await fetchMedia(format.url); }
      catch (e) { attempts.push({ itag: format.itag, error: e.message === 'UNAPPROVED_MEDIA_HOST' ? e.message : 'MEDIA_NETWORK_ERROR' }); continue; }
      const report = { itag: format.itag, trace: media.trace, bytes: media.bytes, error: media.error };
      attempts.push(report);
      if (!media.data) continue;
      const input = join(dir,'source.bin'), output = join(dir,'test.wav');
      await writeFile(input, media.data);
      try {
        const wav = await convert(input, output);
        return { stage: 'converted', api: 'OK', provider, attempts, wav, yemot: 'NOT_TESTED' };
      } catch { report.error = 'AUDIO_DECODE_FAILED'; }
    }
    return { stage: 'download_failed', api: 'OK', provider, attempts, yemot: 'NOT_TESTED' };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function makeServer() {
  let work = null, result = null;
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/health') { res.end('{"ok":true}'); return; }
    const a = Buffer.from(String(req.headers['x-probe-secret'] || ''));
    const b = Buffer.from(process.env.PROBE_SECRET || '');
    if (!b.length || a.length !== b.length || !timingSafeEqual(a,b)) { res.statusCode=403; res.end('{}'); return; }
    if (req.url === '/result' && req.method === 'GET') {
      res.end(JSON.stringify({ running: !!work, result })); return;
    }
    if (req.url === '/probe' && req.method === 'POST') {
      // At most one provider request per process. No retry loop or keep-alive.
      if (!work && !result) {
        work = probe().then(value => { result = value; }, () => {
          result = { stage: 'exception', error: 'PROBE_REQUEST_FAILED' };
        }).finally(() => { work = null; });
      }
      res.statusCode=202; res.end(JSON.stringify({ running: !!work, result })); return;
    }
    res.statusCode=404; res.end('{}');
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.PROBE_SECRET) throw new Error('PROBE_SECRET_REQUIRED');
  makeServer().listen(Number(process.env.PORT)||3000,'0.0.0.0');
}
