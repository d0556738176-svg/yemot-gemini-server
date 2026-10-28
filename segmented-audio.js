// Branch 2: prepare audio in fixed time segments (default 180 s) so playback
// can start after the first segment instead of after the whole file.
//
// Partial download: FFmpeg reads the source through a local counting proxy
// that forwards HTTP Range requests. With `-ss` before `-i`, FFmpeg seeks with
// Range requests on seekable sources, so only the bytes needed for that time
// window are fetched. The proxy measures this; it is never assumed.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

export const SEGMENT_SECONDS = 180;
// Part of every cache path, so 180 s segments never mix with the older
// 120 s chunks (which live under /2/youtube-authorized/).
export const SEGMENT_FORMAT_VERSION = 's180v1';
const SAMPLE_RATE = 8000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // mono, 16 bit

// --- counting Range proxy ----------------------------------------------------

// FFmpeg asks for open-ended ranges ("bytes=X-"). Passing those through makes
// the source stream everything to the end (measured: 100-140% of the file for
// one 3-minute segment). So the proxy answers FFmpeg itself and pulls the
// source in bounded windows only as fast as FFmpeg consumes them.
const WINDOW_BYTES = 256 * 1024;

async function probeLength(upstreamUrl, fetchImpl, signal) {
  const r = await fetchImpl(upstreamUrl, { headers: { range: 'bytes=0-0' }, signal });
  const cr = r.headers.get('content-range') || '';
  await r.body?.cancel().catch(() => {});
  const m = /\/(\d+)\s*$/.exec(cr);
  if (r.status === 206 && m) return { total: Number(m[1]), contentType: r.headers.get('content-type') || 'application/octet-stream' };
  throw Object.assign(new Error('source does not support byte ranges (HTTP ' + r.status + ')'), { code: 'no_range_support' });
}

export async function startRangeCountingProxy(upstreamUrl, { fetchImpl = fetch, signal, windowBytes = WINDOW_BYTES } = {}) {
  const stats = { requests: 0, upstreamRequests: 0, bytes: 0, ranges: [] };
  const { total, contentType } = await probeLength(upstreamUrl, fetchImpl, signal);
  stats.upstreamRequests++;
  stats.totalBytes = total;
  const server = http.createServer(async (req, res) => {
    stats.requests++;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const from = m ? Number(m[1]) : 0;
    const askedTo = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    if (stats.ranges.length < 80) stats.ranges.push(from + '-' + (m && m[2] ? askedTo : ''));
    if (from >= total) { res.writeHead(416, { 'content-range': 'bytes */' + total }); return res.end(); }
    // Answer with at most one window. Content-Range states the true total,
    // so the reader knows more exists and asks again from where it stopped
    // (FFmpeg does this with -reconnect_at_eof). Nothing beyond what the
    // reader actually asks for is pulled from the source.
    const to = Math.min(askedTo, from + windowBytes - 1);
    try {
      stats.upstreamRequests++;
      const up = await fetchImpl(upstreamUrl, { headers: { range: 'bytes=' + from + '-' + to }, signal });
      if (up.status !== 206) throw new Error('upstream range HTTP ' + up.status);
      const buf = Buffer.from(await up.arrayBuffer());
      stats.bytes += buf.length;
      res.writeHead(206, {
        'content-type': contentType, 'accept-ranges': 'bytes', 'content-length': String(buf.length),
        'content-range': 'bytes ' + from + '-' + (from + buf.length - 1) + '/' + total
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: 'http://127.0.0.1:' + port + '/source',
    stats,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); })
  };
}

// --- FFmpeg ------------------------------------------------------------------

function runFfmpeg(args, { signal, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg-static is unavailable'));
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(v); };
    const onAbort = () => { child.kill('SIGKILL'); finish(reject, Object.assign(new Error('ffmpeg aborted'), { code: 'aborted' })); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, Object.assign(new Error('ffmpeg timed out'), { code: 'timeout' })); }, timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-3000); });
    child.on('error', e => finish(reject, e));
    child.on('close', code => code === 0 ? finish(resolve, stderr)
      : finish(reject, Object.assign(new Error('ffmpeg failed (' + code + '): ' + stderr.slice(-400)), { code: 'ffmpeg_failed' })));
  });
}

export async function wavFacts(file) {
  const b = await fs.readFile(file);
  if (b.length < 44 || b.subarray(0, 4).toString() !== 'RIFF' || b.subarray(8, 12).toString() !== 'WAVE')
    throw Object.assign(new Error('not a WAV file'), { code: 'bad_output' });
  // Find the data chunk instead of assuming a 44-byte header.
  let off = 12, dataBytes = 0, dataOffset = 0;
  while (off + 8 <= b.length) {
    const id = b.subarray(off, off + 4).toString(), size = b.readUInt32LE(off + 4);
    if (id === 'data') { dataOffset = off + 8; dataBytes = Math.min(size, b.length - dataOffset); break; }
    off += 8 + size + (size % 2);
  }
  const channels = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  return { bytes: b.length, channels, rate, bits, dataOffset, dataBytes, durationSec: dataBytes / (rate * channels * bits / 8) };
}

// Extract [startSec, startSec+durationSec) as Yemot-ready WAV (8 kHz mono
// 16-bit). Returns facts about the output; durationSec 0 means past the end.
export async function extractSegment({ inputUrl, startSec, durationSec = SEGMENT_SECONDS, outFile, signal, timeoutMs }) {
  const started = Date.now();
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    // Reopen from the current offset whenever a bounded window ends.
    ...(/^https?:/.test(inputUrl) ? ['-reconnect', '1', '-reconnect_at_eof', '1', '-reconnect_delay_max', '2'] : []),
    '-ss', String(startSec), '-t', String(durationSec),
    '-i', inputUrl,
    '-vn', '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le',
    '-f', 'wav', outFile
  ], { signal, timeoutMs });
  const facts = await wavFacts(outFile);
  return { ...facts, ffmpegMs: Date.now() - started };
}

// --- segment preparation with shared cache ------------------------------------

export function segmentRemotePath(sourceKey, index) {
  return 'ivr2:/2/yts/' + SEGMENT_FORMAT_VERSION + '/' + sourceKey + '-' + String(index + 1).padStart(3, '0') + '.wav';
}
export function segmentPlayPath(sourceKey, index) {
  return segmentRemotePath(sourceKey, index).replace(/^ivr2:/, '').replace(/\.wav$/, '');
}

const jobs = new Map(); // key -> {promise, controller, listeners}
let running = 0;
const waiters = [];
const MAX_CONCURRENT = Math.max(1, Number(process.env.BRANCH2_SEGMENT_CONCURRENCY || 2));
async function acquire(signal) {
  if (running < MAX_CONCURRENT) { running++; return; }
  await new Promise((resolve, reject) => {
    const w = { resolve, reject };
    waiters.push(w);
    signal?.addEventListener('abort', () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(signal.reason); }, { once: true });
  });
  running++;
}
function release() { running--; const w = waiters.shift(); if (w) w.resolve(); }

/**
 * Prepare one segment once, shared by every call that needs it.
 * deps: { resolveSourceUrl(signal) -> url, yemot: { isReady(remote), upload(file, remote), verify(remote) }, log }
 * Returns { index, playPath, durationSec, isLast, cached, bytesFetched, timings }.
 */
export function prepareSegment(sourceKey, index, deps) {
  const key = SEGMENT_FORMAT_VERSION + '|' + sourceKey + '|' + index;
  let job = jobs.get(key);
  if (!job) {
    const controller = new AbortController();
    job = { controller, listeners: 0, promise: null };
    job.promise = buildSegment(sourceKey, index, deps, controller.signal)
      .finally(() => { if (jobs.get(key) === job) jobs.delete(key); });
    job.promise.catch(() => {});
    jobs.set(key, job);
  }
  job.listeners++;
  let released = false;
  return {
    promise: job.promise,
    // When the last interested call leaves, unfinished work is cancelled.
    release() {
      if (released) return;
      released = true;
      job.listeners--;
      if (job.listeners <= 0 && jobs.get(key) === job) job.controller.abort(Object.assign(new Error('no listeners'), { code: 'no_listeners' }));
    }
  };
}

async function buildSegment(sourceKey, index, deps, signal) {
  const { yemot, log = console } = deps;
  const remote = segmentRemotePath(sourceKey, index);
  const playPath = segmentPlayPath(sourceKey, index);
  const t0 = Date.now();
  const cached = await yemot.isReady(remote).catch(() => null);
  if (cached?.ready) {
    const durationSec = Number(cached.durationSec) || 0;
    return { index, playPath, durationSec, isLast: durationSec < SEGMENT_SECONDS - 0.5, cached: true, bytesFetched: 0, timings: { cacheMs: Date.now() - t0 } };
  }
  await acquire(signal);
  let temp = null;
  let proxy = null;
  try {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'seg-'));
    const sourceUrl = await deps.resolveSourceUrl(signal);
    proxy = await startRangeCountingProxy(sourceUrl, { signal });
    const out = path.join(temp, 'seg.wav');
    const facts = await extractSegment({ inputUrl: proxy.url, startSec: index * SEGMENT_SECONDS, outFile: out, signal });
    const bytesFetched = proxy.stats.bytes, rangeRequests = proxy.stats.requests;
    if (facts.durationSec < 0.05) {
      return { index, playPath: null, durationSec: 0, isLast: true, cached: false, bytesFetched, rangeRequests, timings: { ffmpegMs: facts.ffmpegMs } };
    }
    signal.throwIfAborted();
    const u0 = Date.now();
    await yemot.upload(out, remote);
    const uploadMs = Date.now() - u0;
    const v0 = Date.now();
    const verified = await yemot.verify(remote);
    if (!verified?.ready) throw Object.assign(new Error('segment not verified on Yemot'), { code: 'not_verified' });
    const result = {
      index, playPath, durationSec: +facts.durationSec.toFixed(3),
      isLast: facts.durationSec < SEGMENT_SECONDS - 0.5,
      cached: false, bytesFetched, rangeRequests,
      timings: { ffmpegMs: facts.ffmpegMs, uploadMs, verifyMs: Date.now() - v0, totalMs: Date.now() - t0 }
    };
    log.info('[SEGMENT] ready', { sourceKey, ...result, timings: JSON.stringify(result.timings) });
    return result;
  } finally {
    await proxy?.close().catch(() => {});
    release();
    if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export function _activeSegmentJobs() { return jobs.size; }
