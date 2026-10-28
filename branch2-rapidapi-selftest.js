// Branch 2 isolated probe: can YTStream (RapidAPI) get audio for the video
// that YouTube blocked directly? Runs once at boot when BRANCH2_RAPIDAPI_TEST_ID
// is set. Resolves an audio URL, downloads a little of it, and (optionally)
// runs the production download+convert+upload chain to prove end to end.
// Logs shapes, status codes and sizes only — never the key or signed URLs.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { resolveRapidApiAudioUrl, isRapidApiConfigured } from './youtube-rapidapi-source.js';

const TAG = '[BRANCH2_RAPIDAPI_SELFTEST]';

function ffmpegToWav(input, output) {
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-t', '60', output], { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = ''; const t = setTimeout(() => { c.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, 60000);
    c.stderr.on('data', d => { e += d; });
    c.on('close', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('ffmpeg ' + code + ': ' + e.slice(-200))); });
  });
}

export async function runBranch2RapidApiSelfTest(env = process.env) {
  const runId = String(env.BRANCH2_RAPIDAPI_TEST_ID || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (!runId) return;
  if (!isRapidApiConfigured(env)) { console.warn(TAG, 'RAPIDAPI_KEY not set'); return; }
  const videoId = String(env.BRANCH2_RAPIDAPI_TEST_VIDEO || 'J8Kqjlh-t5g');
  console.info(TAG, 'start', { runId, videoId });

  let resolved;
  try {
    resolved = await resolveRapidApiAudioUrl(videoId, env);
    console.info(TAG, 'resolved audio url', { bitrate: resolved.bitrate, mime: resolved.mime, host: resolved.host, hasCombined: !!resolved.combinedUrl, meta: JSON.stringify(resolved.meta) });
  } catch (error) {
    console.warn(TAG, 'resolve failed', { code: error?.code || 'error', message: String(error?.message || error).slice(0, 160), meta: JSON.stringify(error?.meta || {}) });
    console.info(TAG, 'summary', JSON.stringify({ resolved: false, downloaded: false, runId }));
    return;
  }

  // Try several download strategies; googlevideo sometimes refuses a bare GET
  // but accepts a browser-like request or a Range request.
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const strategies = [
    ['plain', resolved.url, {}],
    ['browser-ua', resolved.url, { 'user-agent': UA, 'accept': '*/*' }],
    ['range', resolved.url, { 'user-agent': UA, 'range': 'bytes=0-1048575', 'accept': '*/*' }],
    ['range-origin', resolved.url, { 'user-agent': UA, 'range': 'bytes=0-1048575', 'origin': 'https://www.youtube.com', 'referer': 'https://www.youtube.com/' }],
    ...(resolved.combinedUrl ? [['combined-range', resolved.combinedUrl, { 'user-agent': UA, 'range': 'bytes=0-1048575' }]] : [])
  ];
  let working = null;
  for (const [name, dlUrl, headers] of strategies) {
    try {
      const r = await fetch(dlUrl, { headers, signal: AbortSignal.timeout(30000) });
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      console.info(TAG, 'download strategy', { name, httpStatus: r.status, contentType: ct, contentLength: r.headers.get('content-length') || null });
      if ((r.status === 200 || r.status === 206) && /audio|video|octet-stream|mp4|webm/.test(ct)) { working = { name, dlUrl, headers }; await r.body?.cancel().catch(() => {}); break; }
      await r.body?.cancel().catch(() => {});
    } catch (e) {
      console.warn(TAG, 'download strategy error', { name, message: String(e?.message || e).slice(0, 100) });
    }
  }
  if (!working) {
    console.info(TAG, 'summary', JSON.stringify({ resolved: true, downloaded: false, reason: 'all_strategies_403', runId }));
    return;
  }
  console.info(TAG, 'working strategy found', { strategy: working.name });

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'b2rapid-'));
  try {
    const src = path.join(temp, 'audio.src');
    const started = Date.now();
    const dl = await fetch(working.dlUrl, { headers: working.headers, signal: AbortSignal.timeout(60000) });
    if (!dl.ok || !dl.body) throw Object.assign(new Error('audio download HTTP ' + dl.status), { code: 'download_http' });
    const contentType = String(dl.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await dl.arrayBuffer());
    await fs.writeFile(src, buf);
    console.info(TAG, 'downloaded audio', { bytes: buf.length, contentType, ms: Date.now() - started });
    if (!/audio|video|octet-stream|mp4|webm/.test(contentType) || buf.length < 2048) {
      throw Object.assign(new Error('response was not usable audio'), { code: 'not_audio' });
    }

    const wav = path.join(temp, 'audio.wav');
    const c0 = Date.now();
    await ffmpegToWav(src, wav);
    const wavBuf = await fs.readFile(wav);
    const rate = wavBuf.readUInt32LE(24), channels = wavBuf.readUInt16LE(22), bits = wavBuf.readUInt16LE(34);
    const seconds = +((wavBuf.length - 44) / (rate * channels * bits / 8)).toFixed(2);
    console.info(TAG, 'converted', { wavBytes: wavBuf.length, seconds, rate, channels, convertMs: Date.now() - c0 });

    let uploaded = 'skipped';
    if (String(env.BRANCH2_RAPIDAPI_UPLOAD || '').trim() === '1') {
      try {
        const { _pipeline } = await import('./youtube-authorized-playback.js');
        const remote = 'ivr2:/2/rapidtest/' + runId + '-001.wav';
        await _pipeline.uploadToYemot(wav, remote);
        const vu = new URL(_pipeline.YEMOT_API_BASE + '/GetFile');
        vu.searchParams.set('token', _pipeline.yemotApiKey());
        vu.searchParams.set('what', remote);
        const vr = await fetch(vu, { signal: AbortSignal.timeout(8000) });
        const vb = await vr.json().catch(() => null);
        uploaded = (vb?.responseStatus === 'OK' && vb?.file?.exists !== false) ? 'verified' : 'unverified';
        console.info(TAG, 'yemot upload', { remote, result: uploaded, size: vb?.file?.size ?? null });
      } catch (e) { uploaded = 'failed: ' + String(e?.message || e).slice(0, 80); console.warn(TAG, 'upload failed', { uploaded }); }
    }
    console.info(TAG, 'summary', JSON.stringify({ resolved: true, downloaded: true, audioBytes: buf.length, wavSeconds: seconds, yemot: uploaded, runId }));
  } catch (error) {
    console.warn(TAG, 'download/convert failed', { code: error?.code || 'error', message: String(error?.message || error).slice(0, 160) });
    console.info(TAG, 'summary', JSON.stringify({ resolved: true, downloaded: false, runId }));
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
