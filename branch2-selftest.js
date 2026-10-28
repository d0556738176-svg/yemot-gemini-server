// Branch 2 isolated self-test. Runs once at boot only when
// BRANCH2_SELFTEST_ID is set; never touches a live call.
// Logs status codes, sizes, durations and response *shapes* only: no tokens,
// no signed media URLs, no response bodies that could echo credentials.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { _pipeline } from './youtube-authorized-playback.js';

const TAG = '[BRANCH2_SELFTEST]';
// Public-domain sample hosted by Wikimedia Commons; overridable by env.
const DEFAULT_SOURCE = 'https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg';

function shape(value) {
  if (Array.isArray(value)) return 'array(' + value.length + ')';
  if (value && typeof value === 'object') return Object.keys(value).slice(0, 12).join(',');
  return typeof value;
}

async function probe(label, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    console.info(TAG, label, { ok: true, ms: Date.now() - started, ...result });
    return { ok: true, ...result };
  } catch (error) {
    const info = { ok: false, ms: Date.now() - started, error: String(error?.name || '') + ': ' + String(error?.message || error).slice(0, 160) };
    console.warn(TAG, label, info);
    return info;
  }
}

function ffmpegInfo(file) {
  // ffmpeg-static ships no ffprobe; `ffmpeg -i` prints the same stream facts.
  return new Promise(resolve => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', c => { err += c; });
    child.on('close', () => {
      const duration = (err.match(/Duration: (\d+):(\d+):([\d.]+)/) || []).slice(1).map(Number);
      const audio = (err.match(/Audio: ([^\n]+)/) || [])[1] || '';
      resolve({
        durationSec: duration.length ? +(duration[0] * 3600 + duration[1] * 60 + duration[2]).toFixed(2) : null,
        audio: audio.slice(0, 80)
      });
    });
  });
}

async function wavFacts(file) {
  const b = await fs.readFile(file);
  if (b.subarray(0, 4).toString() !== 'RIFF') throw new Error('not RIFF');
  const channels = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  const dataBytes = b.length - 44;
  return { bytes: b.length, channels, rate, bits, durationSec: +(dataBytes / (rate * channels * bits / 8)).toFixed(2) };
}

async function yemotCall(method, params) {
  const url = new URL(_pipeline.YEMOT_API_BASE + '/' + method);
  url.searchParams.set('token', _pipeline.yemotApiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch {}
  return {
    httpStatus: r.status,
    contentType: String(r.headers.get('content-type') || '').slice(0, 40),
    bytes: buf.length,
    responseStatus: json?.responseStatus ?? null,
    jsonShape: json ? shape(json) : 'not-json',
    message: json?.message ? String(json.message).slice(0, 80) : null,
    json
  };
}

export async function runBranch2SelfTest(env = process.env) {
  const runId = String(env.BRANCH2_SELFTEST_ID || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (!runId) return;
  console.info(TAG, 'start', { runId });
  const summary = {};

  // 1. Audio worker reachability (diagnoses the earlier 502).
  const workerBase = String(env.YOUTUBE_AUDIO_WORKER_URL || '').trim().replace(/\/$/, '');
  if (workerBase) {
    for (const attempt of ['first', 'second']) {
      summary['worker_' + attempt] = await probe('worker health ' + attempt, async () => {
        const r = await fetch(workerBase + '/health', { signal: AbortSignal.timeout(90000) });
        const text = await r.text();
        let body = null; try { body = JSON.parse(text); } catch {}
        return { httpStatus: r.status, contentType: String(r.headers.get('content-type') || '').slice(0, 40), json: Boolean(body), status: body?.status ?? null, ffmpeg: body?.ffmpeg ?? null, mediaTool: body?.mediaTool ?? null };
      });
    }
  } else summary.worker_first = { ok: false, error: 'YOUTUBE_AUDIO_WORKER_URL not set' };

  // 1b. One real /prepare-audio call through the worker (yt-dlp path).
  const workerSecret = String(env.YOUTUBE_AUDIO_WORKER_SECRET || '').trim();
  if (workerBase && workerSecret && /^[A-Za-z0-9_-]{11}$/.test(String(env.BRANCH2_SELFTEST_VIDEO || 'J8Kqjlh-t5g'))) {
    summary.worker_prepare = await probe('worker prepare-audio', async () => {
      const r = await fetch(workerBase + '/prepare-audio', {
        method: 'POST', signal: AbortSignal.timeout(120000),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + workerSecret },
        body: JSON.stringify({ videoId: String(env.BRANCH2_SELFTEST_VIDEO || 'J8Kqjlh-t5g'), requestId: crypto.randomUUID() })
      });
      const b = await r.json().catch(() => null);
      return { httpStatus: r.status, json: Boolean(b), status: b?.status ?? null, reason: String(b?.reason || '').slice(0, 60), paths: Array.isArray(b?.playbackPaths) ? b.playbackPaths.length : 0 };
    });
  }

  // 2. YouTube player answer for one id, from this server's IP (status only).
  const videoId = String(env.BRANCH2_SELFTEST_VIDEO || 'J8Kqjlh-t5g');
  if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    summary.youtube_player = await probe('youtube player', async () => {
      const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', 'X-YouTube-Client-Name': '101', 'X-YouTube-Client-Version': '1.02' },
        body: JSON.stringify({ context: { client: { clientName: 'VISIONOS', clientVersion: '1.02', hl: 'he' } }, videoId, contentCheckOk: true, racyCheckOk: true })
      });
      const b = await r.json().catch(() => null);
      return { httpStatus: r.status, videoId, playability: b?.playabilityStatus?.status ?? null, reason: String(b?.playabilityStatus?.reason || '').slice(0, 80), audioFormats: (b?.streamingData?.adaptiveFormats || []).filter(f => /^audio\//.test(f.mimeType || '')).length };
    });
  }

  // 3. Known-accessible audio -> full download -> inspect -> convert -> real
  //    Yemot upload -> verification. Infrastructure proof, not YouTube proof.
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-selftest-'));
  try {
    const sourceUrl = String(env.BRANCH2_SELFTEST_SOURCE_URL || DEFAULT_SOURCE);
    const source = path.join(temp, 'source');
    summary.download = await probe('source download', async () => {
      const r = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'YemotBranch2SelfTest/1.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const declared = Number(r.headers.get('content-length') || 0);
      if (declared && declared !== buf.length) throw new Error('length mismatch ' + buf.length + '/' + declared);
      await fs.writeFile(source, buf);
      return { host: new URL(sourceUrl).hostname, bytes: buf.length, declaredBytes: declared || null, contentType: String(r.headers.get('content-type') || '').slice(0, 40), ...(await ffmpegInfo(source)) };
    });
    if (!summary.download.ok) return;

    let chunks = [];
    summary.convert = await probe('convert', async () => {
      chunks = await _pipeline.makeChunks(source, path.join(temp, 'chunks'));
      return { chunks: chunks.length, first: await wavFacts(chunks[0]) };
    });
    if (!summary.convert.ok) return;

    const remote = 'ivr2:/2/selftest/' + runId + '-001.wav';
    summary.upload = await probe('yemot upload', async () => {
      const r = await _pipeline.uploadToYemot(chunks[0], remote);
      return { responseStatus: r?.responseStatus ?? null, resultShape: shape(r), path: remote };
    });

    // Verification: record what each candidate API actually returns, so the
    // production check can rely on documented behaviour instead of a guess.
    const what = remote;
    for (const [method, params] of [
      ['GetFile', { what }],
      ['DownloadFile', { path: what }],
      ['GetIVR2Dir', { path: 'ivr2:/2/selftest' }],
      ['GetFile_missing', { what: 'ivr2:/2/selftest/' + runId + '-does-not-exist.wav' }]
    ]) {
      summary['verify_' + method] = await probe('verify ' + method, async () => {
        const r = await yemotCall(method.replace(/_missing$/, ''), params);
        const listed = method === 'GetIVR2Dir'
          ? (r.json?.files || []).find(f => String(f?.name || f?.fileName || '').startsWith(runId))
          : null;
        const { json, ...rest } = r;
        const fileInfo = r.json?.file && typeof r.json.file === 'object'
          ? { keys: shape(r.json.file), exists: r.json.file.exists ?? null, size: r.json.file.size ?? null, duration: r.json.file.duration ?? null }
          : undefined;
        return { ...rest, fileInfo, listedFile: listed ? { name: String(listed.name || listed.fileName).slice(0, 60), size: listed.size ?? null, duration: listed.duration ?? listed.durationStr ?? null, keys: shape(listed) } : undefined };
      });
    }
    summary.playbackPath = '/2/selftest/' + runId + '-001';
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    console.info(TAG, 'summary', JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, typeof v === 'object' ? v.ok : v]))));
  }
}
