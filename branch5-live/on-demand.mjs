import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const channel12 = Object.freeze({
  extension: '/5/1', name: 'ערוץ 12',
  officialPage: 'https://www.mako.co.il/mako-vod-live-tv/VOD-6540b8dcb64fd31006.htm',
  // Found in the official page; HTTP 403 in testing. Not a verified usable source.
  candidate: 'https://mako-streaming.akamaized.net/stream/hls/live/20000821/k12rh-dvr/index.m3u8?b-in-range=0-800',
});

export function validateSource(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password ||
      u.hostname !== 'mako-streaming.akamaized.net' || u.port) {
    throw new Error('SOURCE_NOT_ALLOWED');
  }
  return u.href;
}

// No source discovery, auth bypass, keep-alive or process starts on import.
export async function captureChunk({ source, file, signal, seconds = 15, ffmpeg = 'ffmpeg' }) {
  validateSource(source);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('BAD_DURATION');
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-rw_timeout', '10000000', '-protocol_whitelist', 'https,tls,tcp,crypto',
      '-i', source, '-t', String(seconds), '-vn', '-ar', '8000', '-ac', '1',
      '-c:a', 'pcm_s16le', '-fs', '1000000', file,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    // Never log stderr: a provider may put signed source URLs in it.
    child.stderr.resume();
    let deadline = false;
    const cancel = () => child.kill('SIGKILL');
    const timer = setTimeout(() => { deadline = true; cancel(); }, 45000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    child.once('error', () => { clean(); reject(new Error('FFMPEG_START_FAILED')); });
    child.once('close', code => {
      clean();
      if (signal.aborted) reject(new Error('CANCELLED'));
      else if (deadline) reject(new Error('SOURCE_TIMEOUT'));
      else if (code !== 0) reject(new Error('SOURCE_UNAVAILABLE'));
      else resolve();
    });
  });
  const size = (await stat(file)).size;
  if (size < 1600 || size > 1000000) throw new Error('INVALID_AUDIO');
}

/** Isolated POC engine, not a wired Yemot HTTP handler.
 * An adapter must authenticate callers, map ApiCallId, call next only after
 * playback, and call stop on hangup/exit. publish must honour AbortSignal.
 * A callback retry must reuse the same sequence number.
 */
export function createOnDemand({ source, publish, capture = captureChunk,
  idleMs = 60000, maxSessions = 2, maxCallMs = 3600000 } = {}) {
  if (typeof publish !== 'function') throw new Error('PUBLISH_REQUIRED');
  if (source) validateSource(source);
  const sessions = new Map();
  const stop = id => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id); clearTimeout(s.timer); s.controller.abort();
  };
  const touch = (id, s) => {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => stop(id), Math.min(idleMs, Math.max(0, s.expires - Date.now())));
    s.timer.unref?.();
  };
  function enter(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('CALL_ID_REQUIRED');
    if (!source) throw new Error('SOURCE_NOT_CONFIGURED');
    if (sessions.has(id)) { touch(id, sessions.get(id)); return; }
    if (sessions.size >= maxSessions) throw new Error('BUSY');
    const s = { controller: new AbortController(), seq: -1, result: null,
      work: null, timer: null, expires: Date.now() + maxCallMs };
    sessions.set(id, s); touch(id, s);
  }
  function next(id, sequence) {
    const s = sessions.get(id);
    if (!s) return Promise.reject(new Error('SESSION_EXPIRED'));
    if (Date.now() >= s.expires) { stop(id); return Promise.reject(new Error('CALL_LIMIT')); }
    if (!Number.isSafeInteger(sequence) || sequence < 0) return Promise.reject(new Error('BAD_SEQUENCE'));
    touch(id, s);
    if (sequence === s.seq) return s.work || Promise.resolve(s.result);
    if (s.work || sequence !== s.seq + 1) return Promise.reject(new Error('BAD_SEQUENCE'));
    s.seq = sequence;
    s.work = (async () => {
      const dir = await mkdtemp(join(tmpdir(), 'yemot-live-'));
      try {
        const file = join(dir, 'chunk.wav');
        await capture({ source, file, signal: s.controller.signal });
        s.controller.signal.throwIfAborted();
        const result = await publish({ file, sequence, callId: id, signal: s.controller.signal });
        s.controller.signal.throwIfAborted();
        s.result = result; return result;
      } catch (error) { stop(id); throw error; }
      finally { await rm(dir, { recursive: true, force: true }); s.work = null; }
    })();
    return s.work;
  }
  return { enter, next, stop, close() { for (const id of sessions.keys()) stop(id); },
    get activeSessions() { return sessions.size; } };
}
