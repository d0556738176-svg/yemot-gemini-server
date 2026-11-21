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

// A compact decimal range, with no ':' (RE uses ':' between filter options).
function heightPattern(max) {
  const digits=String(max), terms=[];
  for(let n=1;n<digits.length;n++) terms.push(n===1?'[1-9]':'[1-9][0-9]{'+(n-1)+'}');
  for(let i=0;i<digits.length;i++) {
    const low=i===0?1:0, high=Number(digits[i])-1;
    if(high<low)continue;
    const digit=low===high?String(low):'['+low+'-'+high+']';
    const rest=digits.length-i-1;
    terms.push(digits.slice(0,i)+digit+(rest?'[0-9]{'+rest+'}':''));
  }
  terms.push(digits);
  return '('+terms.join('|')+')';
}

export function streamVideoSelection(mode, height) {
  // Audio: keep the best source, including muxed HLS when no separate audio
  // track exists. Video: match the caller's existing resolution ceiling.
  if(mode!=='video')return 'for=best';
  const ceiling=Math.max(1,Math.min(8640,Math.floor(Number(height)||720)));
  // A direct media playlist can omit resolution entirely; keep that source
  // eligible, as the regular downloader's final best-format fallback does.
  return 'res=^([0-9]+x'+heightPattern(ceiling)+')?$:for=best';
}

export function streamDownloadArgs(web, dir, ffmpegPath, {mode='audio',height}={}) {
  return [web.url, '--save-dir', dir, '--tmp-dir', path.join(dir, 'parts'), '--save-name', 'media',
    '--select-video', streamVideoSelection(mode,height), '--select-audio', 'for=best', '--drop-subtitle', 'all',
    '--thread-count', '2', '--download-retry-count', '2', '--http-request-timeout', '15',
    '--check-segments-count', 'true',
    // Separate audio and video tracks (common on TV sites) become one file;
    // without this the job failed with two files and fell back to yt-dlp.
    '-M', 'format=mkv',
    '--no-log', '--write-meta-json', 'false', '--disable-update-check', '--no-ansi-color', '--log-level', 'OFF',
    '--ffmpeg-binary-path', ffmpegPath,
    ...Object.entries(mediaRequestHeaders({ ...web.httpHeaders, ...(web.referer ? { Referer: web.referer } : {}) })).flatMap(([k, v]) => ['-H', k + ': ' + v]),
    // A cookie the page set in the browser engine: this download only, never stored.
    ...(web.cookie && !/[\r\n]/.test(web.cookie) ? ['-H', 'Cookie: ' + web.cookie] : [])];
}

// The tool's own progress bars ("Vid 1280x720 ━━━ 45/300 15.00%"): one per
// track. Overall = segments done / segments in all tracks, as measured.
export function parseStreamProgress(text, tracks = new Map()) {
  const clean = String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  for (const m of clean.matchAll(/(Vid|Aud|Sub)\b([^━\r\n]{0,80}?)\s*━+\s*(\d+)\/(\d+)\s+[\d.]+%/g)) {
    const done = Number(m[3]), total = Number(m[4]);
    if (total > 0 && done <= total) tracks.set(m[1] + '|' + m[2].replace(/\d{2}:\d{2}:\d{2}\.\d+.*$/, '').trim(), { done, total }); // a track's "0/100" placeholder is replaced by its real count
  }
  let done = 0, total = 0;
  for (const t of tracks.values()) { done += t.done; total += t.total; }
  return total ? { done, total, percent: Math.floor(done / total * 100) } : null;
}

// The tool crashes (Spectre.Console: "Offset and length were out of bounds")
// when its output is not a terminal, at a random moment of a long download:
// it ran with no screen, so long episodes failed after minutes of work and no
// percent was ever heard (18.11). It runs inside a pseudo-terminal instead,
// which is also where its progress bars come from.
const SCRIPT_BIN = ['/usr/bin/script', '/bin/script'].find(x => existsSync(x)) || null;
const shq = a => "'" + String(a).replace(/'/g, "'\\''") + "'";
export function terminalCommand(bin, args, scriptBin = SCRIPT_BIN) {
  if (!scriptBin) return { bin, args, tty: false };
  return { bin: scriptBin, args: ['-qfec', [bin, ...args].map(shq).join(' '), '/dev/null'], tty: true };
}

async function treeBytes(dir) {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? await treeBytes(p) : e.isFile() ? (await fs.stat(p).catch(() => ({ size: 0 }))).size : 0;
  }
  return n;
}

function run(bin0, args0, { signal, timeoutMs, stallMs = timeoutMs, dir, maxBytes = Infinity, onProgress, tty = false }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const grouped = process.platform !== 'win32';
    // On a terminal the bars are drawn only above log level OFF.
    const ttyArgs = tty ? args0.map((a, i) => a === 'OFF' && args0[i - 1] === '--log-level' ? 'ERROR' : a) : args0;
    const { bin, args } = tty ? terminalCommand(bin0, ttyArgs) : { bin: bin0, args: args0 };
    const p = spawn(bin, args, { detached: grouped, stdio: ['ignore','pipe','pipe'], env: { ...process.env, COLUMNS: '180', LINES: '60', TERM: 'xterm' } });
    let diagnostic='', tail='', lastPct=-1;
    const tracks=new Map();
    const take=d=>{
      diagnostic=(diagnostic+d).slice(-2048);
      if(!onProgress)return;
      tail=(tail+d).slice(-4000);
      const pr=parseStreamProgress(tail,tracks);
      if(pr&&pr.percent!==lastPct){lastPct=pr.percent;try{onProgress(pr);}catch{}}
    };
    p.stdout.on('data',take);
    p.stderr.on('data',take);
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
    // 21.11: the tool's own last words go with the failure (no tickets).
    const why = () => String(diagnostic).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/https?:\/\/\S+/g, '[address]').replace(/[━─]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-240);
    p.on('close', code => finish(code === 0 ? null : Object.assign(new Error('stream tool failed (' + code + '): ' + why()), { code: /No stream found to download/i.test(diagnostic)?'stream_no_matching_tracks':'direct_failed' })));
  });
}

// Use the same quality requested by the regular download job. The shared
// conversion/upload pipeline still chooses the final format and folder.
export async function downloadStreamMedia(web, output, { bin = streamDownloaderPath(), ffmpegPath = 'ffmpeg', mode = 'audio', height, signal, maxBytes = Infinity, stallMs = 60000, onProgress, timeoutMs = Number(process.env.WEB_STREAM_TIMEOUT_MS) || 6 * 3600 * 1000 /* 18.11: long episodes too, as in extension 2; a stall still stops it after a minute */ } = {}) {
  if (!bin || !/^https?:\/\//i.test(web?.url || '') || !/\.(?:m3u8|mpd)(?:\?|$)/i.test(web.url)) throw Object.assign(new Error('stream fallback unavailable'), { code: 'stream_unavailable' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ivr-stream-'));
  try {
    try {
      await run(bin, streamDownloadArgs(web, dir, ffmpegPath, {mode,height}), { signal, timeoutMs, stallMs, dir, maxBytes, onProgress, tty: true });
    } catch(e) {
      // Direct HLS playlists can have no resolution labels to filter. This
      // matches the regular downloader's final best-available fallback.
      if(mode!=='video'||e.code!=='stream_no_matching_tracks')throw e;
      await run(bin, streamDownloadArgs(web, dir, ffmpegPath, {mode:'audio'}), { signal, timeoutMs, stallMs, dir, maxBytes, onProgress, tty: true });
    }
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
