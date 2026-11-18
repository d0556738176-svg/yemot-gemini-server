import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mediaRequestHeaders } from './media-request-headers.js';

export function streamDownloaderPath(env = process.env) {
  const bin = env.N_M3U8DL_RE_PATH || '/usr/local/bin/N_m3u8DL-RE';
  return existsSync(bin) ? bin : null;
}

export function streamDownloadArgs(web, dir, ffmpegPath) {
  return [web.url, '--save-dir', dir, '--tmp-dir', path.join(dir, 'parts'), '--save-name', 'media',
    '--select-video', 'for=worst', '--select-audio', 'for=worst', '--drop-subtitle', 'all',
    '--thread-count', '2', '--download-retry-count', '2', '--http-request-timeout', '15',
    '--check-segments-count', 'true',
    '--no-log', '--write-meta-json', 'false', '--disable-update-check', '--no-ansi-color', '--log-level', 'OFF',
    '--ffmpeg-binary-path', ffmpegPath,
    ...Object.entries(mediaRequestHeaders({ ...web.httpHeaders, ...(web.referer ? { Referer: web.referer } : {}) })).flatMap(([k, v]) => ['-H', k + ': ' + v])];
}

async function treeBytes(dir) {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? await treeBytes(p) : e.isFile() ? (await fs.stat(p).catch(() => ({ size: 0 }))).size : 0;
  }
  return n;
}

function run(bin, args, { signal, timeoutMs, stallMs = timeoutMs, dir, maxBytes = Infinity }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const grouped = process.platform !== 'win32';
    const p = spawn(bin, args, { detached: grouped, stdio: 'ignore', env: { ...process.env, COLUMNS: '180', LINES: '60', TERM: 'xterm' } });
    let done = false, lastBytes = 0, lastChange = Date.now(), checking = false;
    const stop = () => { try { grouped && p.pid ? process.kill(-p.pid, 'SIGKILL') : p.kill('SIGKILL'); } catch {} };
    const finish = error => {
      if (done) return; done = true;
      clearTimeout(timer); clearInterval(monitor); signal?.removeEventListener('abort', abort);
      if (error) { stop(); reject(error); } else resolve();
    };
    const abort = () => finish(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timer = setTimeout(() => finish(Object.assign(new Error('stream download timed out'), { code: 'direct_stalled' })), timeoutMs);
    const monitor = setInterval(async () => {
      if (checking || done || !dir) return; checking = true;
      try {
        const bytes = await treeBytes(dir);
        if (bytes > maxBytes) finish(Object.assign(new Error('Source exceeds supported size'), { code: 'too_large' }));
        else if (bytes !== lastBytes) { lastBytes = bytes; lastChange = Date.now(); }
        else if (Date.now() - lastChange > stallMs) finish(Object.assign(new Error('stream download stalled'), { code: 'direct_stalled' }));
      } finally { checking = false; }
    }, 1000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    p.on('error', () => finish(Object.assign(new Error('stream tool unavailable'), { code: 'stream_unavailable' })));
    p.on('close', code => finish(code === 0 ? null : Object.assign(new Error('stream tool failed'), { code: 'direct_failed' })));
  });
}

// Lowest available stream is intentional: keep the fallback affordable for the
// phone service. Complete segment-count verification remains enabled in RE.
export async function downloadStreamMedia(web, output, { bin = streamDownloaderPath(), ffmpegPath = 'ffmpeg', mode = 'audio', signal, maxBytes = Infinity, stallMs = 60000, timeoutMs = 15 * 60 * 1000 } = {}) {
  if (!bin || !/^https?:\/\//i.test(web?.url || '') || !/\.(?:m3u8|mpd)(?:\?|$)/i.test(web.url)) throw Object.assign(new Error('stream fallback unavailable'), { code: 'stream_unavailable' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ivr-stream-'));
  try {
    await run(bin, streamDownloadArgs(web, dir, ffmpegPath), { signal, timeoutMs, stallMs, dir, maxBytes });
    const files = (await fs.readdir(dir)).filter(x => /\.(?:mp4|m4a|mkv|ts|aac)$/i.test(x));
    // A single combined track is expected. Never silently choose one of
    // several independently downloaded DASH tracks.
    if (files.length !== 1) throw Object.assign(new Error('stream requires a combined media file'), { code: 'direct_failed' });
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(dir, files[0]), ...(mode === 'video' ? ['-map', '0:v:0', '-map', '0:a:0?'] : ['-map', '0:a:0', '-vn']), '-c', 'copy', '-f', mode === 'video' ? 'mp4' : 'matroska', output], { signal, timeoutMs: 60000 });
    const { size } = await fs.stat(output);
    if (!size || size > maxBytes) throw Object.assign(new Error('invalid stream output size'), { code: size > maxBytes ? 'too_large' : 'direct_failed' });
    return { bytes: size, title: web.title || null, client: 'N_m3u8DL-RE', captions: [] };
  } catch (e) { await fs.rm(output, { force: true }).catch(() => {}); throw e; }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
