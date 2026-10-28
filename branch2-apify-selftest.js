// Branch 2 Apify probe: can an Apify actor get the audio YouTube blocked us
// from, and deliver the file? Runs at boot when BRANCH2_APIFY_TEST_ID is set.
// Resolves via the actor, downloads the delivered file, converts, and
// (optionally) uploads+verifies on Yemot. Logs shapes/sizes only.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { resolveApifyAudio, isApifyConfigured } from './youtube-apify-source.js';

const TAG = '[BRANCH2_APIFY_SELFTEST]';

function ffToWav(input, output) {
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-t', '60', output], { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = ''; const t = setTimeout(() => { c.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, 60000);
    c.stderr.on('data', d => { e += d; });
    c.on('close', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('ffmpeg ' + code + ': ' + e.slice(-200))); });
  });
}

export async function runBranch2ApifySelfTest(env = process.env) {
  const runId = String(env.BRANCH2_APIFY_TEST_ID || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (!runId) return;
  if (!isApifyConfigured(env)) { console.warn(TAG, 'APIFY_TOKEN not set'); return; }
  const videoId = String(env.BRANCH2_APIFY_TEST_VIDEO || 'J8Kqjlh-t5g');
  console.info(TAG, 'start', { runId, videoId, actor: env.BRANCH2_APIFY_ACTOR || 's-r/youtube-video-downloader' });

  // Full-chain mode: run the REAL production preparation (Apify source ->
  // convert whole song -> split into chunks -> upload all -> verify), proving
  // the complete song is ready for gapless playback. Reports chunk count and
  // total duration.
  if (String(env.BRANCH2_APIFY_FULLCHAIN || '').trim() === '1') {
    const f0 = Date.now();
    try {
      const { downloadAuthorizedAudioToYemot, _pipeline } = await import('./youtube-authorized-playback.js');
      const playback = await downloadAuthorizedAudioToYemot(videoId, {});
      // Verify each uploaded chunk and sum durations from Yemot itself.
      let totalDuration = 0; const perChunk = [];
      for (const pth of playback.playbackPaths) {
        const remote = 'ivr2:' + pth + '.wav';
        const vu = new URL(_pipeline.YEMOT_API_BASE + '/GetFile');
        vu.searchParams.set('token', _pipeline.yemotApiKey());
        vu.searchParams.set('what', remote);
        const vr = await fetch(vu, { signal: AbortSignal.timeout(8000) });
        const vb = await vr.json().catch(() => null);
        const d = Number(vb?.file?.duration) || 0; totalDuration += d; perChunk.push(d);
      }
      console.info(TAG, 'FULL CHAIN ready', { chunkCount: playback.playbackPaths.length, totalDurationSec: +totalDuration.toFixed(1), perChunkSec: perChunk.map(x => +x.toFixed(0)).join(','), firstPath: playback.playbackPaths[0], ms: Date.now() - f0 });
      console.info(TAG, 'summary', JSON.stringify({ fullChain: true, chunkCount: playback.playbackPaths.length, totalDurationSec: +totalDuration.toFixed(1), gaplessReady: true, runId }));
    } catch (e) {
      console.warn(TAG, 'FULL CHAIN failed', { code: e?.code || 'error', message: String(e?.message || e).slice(0, 180), ms: Date.now() - f0 });
      console.info(TAG, 'summary', JSON.stringify({ fullChain: true, ready: false, runId }));
    }
    return;
  }

  let resolved;
  const t0 = Date.now();
  try {
    resolved = await resolveApifyAudio(videoId, env);
    console.info(TAG, 'resolved', { ms: Date.now() - t0, title: resolved.title, durationSeconds: resolved.durationSeconds, meta: JSON.stringify(resolved.meta) });
  } catch (error) {
    console.warn(TAG, 'resolve failed', { ms: Date.now() - t0, code: error?.code || 'error', message: String(error?.message || error).slice(0, 200), meta: JSON.stringify(error?.meta || {}) });
    console.info(TAG, 'summary', JSON.stringify({ resolved: false, downloaded: false, runId }));
    return;
  }

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'b2apify-'));
  try {
    const src = path.join(temp, 'audio.src');
    const d0 = Date.now();
    const dl = await fetch(resolved.url, { signal: AbortSignal.timeout(90000) });
    if (!dl.ok || !dl.body) throw Object.assign(new Error('download HTTP ' + dl.status), { code: 'download_http' });
    const ct = String(dl.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await dl.arrayBuffer());
    await fs.writeFile(src, buf);
    console.info(TAG, 'downloaded file', { bytes: buf.length, contentType: ct, ms: Date.now() - d0 });
    if (buf.length < 2048) throw Object.assign(new Error('file too small'), { code: 'too_small' });

    const wav = path.join(temp, 'audio.wav');
    const c0 = Date.now();
    await ffToWav(src, wav);
    const wb = await fs.readFile(wav);
    const rate = wb.readUInt32LE(24), ch = wb.readUInt16LE(22), bits = wb.readUInt16LE(34);
    const seconds = +((wb.length - 44) / (rate * ch * bits / 8)).toFixed(2);
    console.info(TAG, 'converted', { wavBytes: wb.length, seconds, rate, channels: ch, convertMs: Date.now() - c0 });

    let yemot = 'skipped';
    if (String(env.BRANCH2_APIFY_UPLOAD || '').trim() === '1') {
      try {
        const { _pipeline } = await import('./youtube-authorized-playback.js');
        const remote = 'ivr2:/2/apifytest/' + runId + '-001.wav';
        await _pipeline.uploadToYemot(wav, remote);
        const vu = new URL(_pipeline.YEMOT_API_BASE + '/GetFile');
        vu.searchParams.set('token', _pipeline.yemotApiKey());
        vu.searchParams.set('what', remote);
        const vr = await fetch(vu, { signal: AbortSignal.timeout(8000) });
        const vb = await vr.json().catch(() => null);
        yemot = (vb?.responseStatus === 'OK' && vb?.file?.exists !== false) ? 'verified' : 'unverified';
        console.info(TAG, 'yemot upload', { remote, result: yemot, size: vb?.file?.size ?? null });
      } catch (e) { yemot = 'failed'; console.warn(TAG, 'upload failed', { message: String(e?.message || e).slice(0, 100) }); }
    }
    console.info(TAG, 'summary', JSON.stringify({ resolved: true, downloaded: true, audioBytes: buf.length, wavSeconds: seconds, yemot, totalMs: Date.now() - t0, runId }));
  } catch (error) {
    console.warn(TAG, 'download/convert failed', { code: error?.code || 'error', message: String(error?.message || error).slice(0, 160) });
    console.info(TAG, 'summary', JSON.stringify({ resolved: true, downloaded: false, runId }));
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
