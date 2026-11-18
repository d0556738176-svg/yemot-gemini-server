// Direct YouTube download on our own server (owner, 15.11: "first download
// straight from YouTube through the server's command line; only if that fails,
// our engine and its backup keys"). The server is in Israel (Empire), so
// videos YouTube allows only in Israel also come straight. yt-dlp is tried
// with several YouTube player types in turn; a try that stops making progress
// for a minute is stopped and the next one starts. Any failure is thrown and
// the caller goes on to the paid engines exactly as before.
// YOUTUBE_DIRECT=off turns this off.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { webItem } from './web-items.js';

const require = createRequire(import.meta.url);
// /usr/local/bin/yt-dlp is the up-to-date standalone build the server
// refreshes every night (the copy inside node_modules can be months old).
export function ytdlpPath(env = process.env) {
  if (env.YTDLP_PATH) return env.YTDLP_PATH;
  if (existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp';
  try { return path.join(path.dirname(require.resolve('youtube-dl-exec/package.json')), 'bin', 'yt-dlp'); }
  catch { return 'yt-dlp'; }
}

// Player types tried in order ('' = yt-dlp's own default choice).
export const CLIENTS = ['', 'tv,web_safari', 'android_vr', 'web_embedded,mweb'];

export function directEnabled(env = process.env) {
  return String(env.YOUTUBE_DIRECT || 'on').toLowerCase() !== 'off';
}

export function formatFor(mode, height) {
  // Owner, 15.11: the best sound YouTube has (usually Opus ~160k, else AAC).
  if (mode !== 'video') return 'bestaudio/best';
  const h = Number(height) || 720;
  return `bestvideo[height<=${h}][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
}

export function argsFor(videoId, output, { mode = 'audio', height, client = '', ffmpegPath, target = null, impersonate = false } = {}) {
  const a = ['--no-warnings', '--no-playlist', '--newline', '--no-part', '--force-overwrites', '--no-cache-dir',
    '--retries', '3', '--fragment-retries', '5', '--socket-timeout', '30', '--concurrent-fragments', '4',
    '-f', formatFor(mode, height), '-o', output,
    '--print', 'after_move:TITLE:%(title)s', '--no-simulate', '--progress'];
  if (mode === 'video') a.push('--merge-output-format', 'mp4');
  if (ffmpegPath) a.push('--ffmpeg-location', ffmpegPath);
  if (client) a.push('--extractor-args', 'youtube:player_client=' + client);
  if (impersonate) a.push('--impersonate', 'chrome');
  a.push('--', target || videoId);
  return a;
}

// "[download]  42.0% of   10.05MiB at ..." -> { done, total } in bytes
export function parseProgress(line) {
  const m = /\[download\]\s+([\d.]+)% of\s+~?\s*([\d.]+)\s*(KiB|MiB|GiB|B)\b/.exec(line);
  if (!m) return null;
  const mult = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[m[3]];
  const total = Math.round(Number(m[2]) * mult);
  return { done: Math.round(total * Number(m[1]) / 100), total };
}

function runOnce(bin, args, { signal, stallMs, onProgress }) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: (process.env.PATH || '') + ':/usr/local/bin:/usr/bin' } });
    let title = null, err = '', timer;
    const stall = () => { clearTimeout(timer); timer = setTimeout(() => { p.kill('SIGKILL'); reject(Object.assign(new Error('direct download stalled'), { code: 'direct_stalled' })); }, stallMs); };
    const onAbort = () => { p.kill('SIGKILL'); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    signal?.addEventListener('abort', onAbort, { once: true });
    stall();
    p.stdout.on('data', d => {
      stall();
      for (const line of String(d).split('\n')) {
        if (line.startsWith('TITLE:')) title = line.slice(6).trim();
        const pr = parseProgress(line);
        if (pr) onProgress?.(pr);
      }
    });
    p.stderr.on('data', d => { stall(); err = (err + d).slice(-2000); });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve(title);
      else reject(Object.assign(new Error((err.trim().split('\n').filter(Boolean).pop() || 'yt-dlp exit ' + code).slice(0, 300)), { code: 'direct_failed' }));
    });
  });
}

// Downloads to `output`; returns { bytes, title, client }. Throws when every
// player type failed (the caller then uses the engines).
export async function directDownload(videoId, output, { mode = 'audio', height, ffmpegPath, signal, onProgress, log = console, maxBytes = Infinity, stallMs = 60000, clients = CLIENTS, bin = ytdlpPath(), withCaptions = true } = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) throw Object.assign(new Error('invalid video id'), { code: 'invalid_video' });
  // A video from another website (web-items.js): its own link, no YouTube player types.
  const web = await webItem(videoId);
  if (web) clients = [''];
  let last = null;
  for (const client of clients) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const t0 = Date.now();
    try {
      await fs.rm(output, { force: true });
      const title = await runOnce(bin, argsFor(videoId, output, { mode, height, client, ffmpegPath, target: web?.url, impersonate: !!web?.impersonate }), { signal, stallMs, onProgress });
      const { size } = await fs.stat(output);
      if (!size) throw Object.assign(new Error('empty file'), { code: 'direct_failed' });
      if (size > maxBytes) { await fs.rm(output, { force: true }); throw Object.assign(new Error('Source exceeds supported size'), { code: 'too_large' }); }
      log.info?.('[DIRECT] downloaded straight from YouTube', { videoId, mode, client: client || 'default', bytes: size, seconds: Math.round((Date.now() - t0) / 1000) });
      // Captions (owner, 15.11): fetched separately, never able to fail the download.
      let captions = [];
      if (withCaptions) {
        captions = await directCaptions(videoId, output, { bin, client, log, target: web?.url, impersonate: !!web?.impersonate }).catch(() => []);
        if (captions.length && mode === 'video' && ffmpegPath) await embedCaptions(output, captions, ffmpegPath).catch(e => log.warn?.('[DIRECT] captions not embedded', { videoId, message: String(e?.message || e).slice(0, 120) }));
        if (captions.length && mode !== 'video') await fs.writeFile(output + '.lyrics.txt', lyricsText(captions)).catch(() => {});
      }
      return { bytes: (await fs.stat(output)).size, title, client, captions: captions.map(c => c.lang) };
    } catch (e) {
      if (e?.name === 'AbortError' || e?.code === 'too_large') throw e;
      last = e;
      log.warn?.('[DIRECT] try failed', { videoId, mode, client: client || 'default', message: String(e?.message || e).slice(0, 200) });
    }
  }
  await fs.rm(output, { force: true }).catch(() => {});
  throw last || Object.assign(new Error('direct download failed'), { code: 'direct_failed' });
}

// Quick check (no download) that YouTube gives this server the file: used
// before a video job, so the caller is asked about the paid engine at once
// when the free way cannot work (15.11). Same player types as the download.
export async function directProbe(videoId, { mode = 'audio', height, timeoutMs = 45000, clients = CLIENTS, bin = ytdlpPath(), log = console } = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) return false;
  const web = await webItem(videoId);
  if (web) clients = [''];
  const until = Date.now() + timeoutMs;
  for (const client of clients) {
    const left = until - Date.now();
    if (left < 3000) break;
    const args = ['--no-warnings', '--no-playlist', '--simulate', '-f', formatFor(mode, height), ...(client ? ['--extractor-args', 'youtube:player_client=' + client] : []), ...(web?.impersonate ? ['--impersonate', 'chrome'] : []), '--', web?.url || videoId];
    const ok = await new Promise(resolve => {
      const p = spawn(bin, args, { stdio: 'ignore', env: { ...process.env, PATH: (process.env.PATH || '') + ':/usr/local/bin:/usr/bin' } });
      const t = setTimeout(() => { p.kill('SIGKILL'); resolve(false); }, left);
      p.on('error', () => { clearTimeout(t); resolve(false); });
      p.on('close', c => { clearTimeout(t); resolve(c === 0); });
    });
    if (ok) return true;
  }
  log.warn?.('[DIRECT] probe: YouTube does not give this file to the server', { videoId, mode });
  return false;
}

// Hebrew, English and the original-language captions YouTube has for the
// video (written by the uploader first, else automatic), as SRT files next to
// `output`. Returns [{ lang, file }]. At most a minute; failures give [].
export const CAPTION_LANGS = 'he,iw,en,.*-orig';
export async function directCaptions(videoId, output, { bin = ytdlpPath(), client = '', log = console, timeoutMs = 60000, target = null, impersonate = false } = {}) {
  const dir = path.dirname(output), base = path.basename(output) + '.cap';
  const args = ['--no-warnings', '--no-playlist', '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', CAPTION_LANGS,
    '--sub-format', 'srt/vtt/best', '--convert-subs', 'srt', '--sleep-subtitles', '1', '-o', path.join(dir, base + '.%(ext)s'),
    ...(client ? ['--extractor-args', 'youtube:player_client=' + client] : []), ...(impersonate ? ['--impersonate', 'chrome'] : []), '--', target || videoId];
  await new Promise(resolve => {
    const p = spawn(bin, args, { stdio: 'ignore', env: { ...process.env, PATH: (process.env.PATH || '') + ':/usr/local/bin:/usr/bin' } });
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve(); }, timeoutMs);
    p.on('error', () => { clearTimeout(t); resolve(); });
    p.on('close', () => { clearTimeout(t); resolve(); });
  });
  const names = (await fs.readdir(dir).catch(() => [])).filter(n => n.startsWith(base + '.') && n.endsWith('.srt'));
  const out = [];
  for (const n of names) {
    const lang = n.slice(base.length + 1, -4).replace(/-orig$/, '');
    const file = path.join(dir, n);
    if ((await fs.stat(file)).size > 20) out.push({ lang: lang === 'iw' ? 'he' : lang, file });
  }
  // Hebrew first, then English, then the rest; one file per language.
  const order = l => (l.startsWith('he') ? 0 : l.startsWith('en') ? 1 : 2);
  const seen = new Set();
  const list = out.sort((a, b) => order(a.lang) - order(b.lang)).filter(c => { const k = c.lang.slice(0, 2); if (seen.has(k)) return false; seen.add(k); return true; });
  if (list.length) log.info?.('[DIRECT] captions', { videoId, languages: list.map(c => c.lang) });
  return list;
}

const ISO3 = { he: 'heb', en: 'eng', ar: 'ara', ru: 'rus', fr: 'fre', es: 'spa', de: 'ger', yi: 'yid' };
const NAMES = { he: 'עברית', en: 'English', yi: 'יידיש' };
// Every caption language becomes its own subtitle track in the mp4 (streams
// copied, nothing re-encoded); Hebrew is the default track.
export async function embedCaptions(file, captions, ffmpegPath) {
  const tmp = file + '.subs.mp4';
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file];
  for (const c of captions) args.push('-i', c.file);
  args.push('-map', '0:v', '-map', '0:a?');
  captions.forEach((c, i) => args.push('-map', String(i + 1) + ':0'));
  args.push('-c', 'copy', '-c:s', 'mov_text');
  captions.forEach((c, i) => {
    const l = c.lang.slice(0, 2);
    args.push('-metadata:s:s:' + i, 'language=' + (ISO3[l] || l), '-metadata:s:s:' + i, 'title=' + (NAMES[l] || c.lang), '-disposition:s:' + i, i === 0 ? 'default' : '0');
  });
  args.push(tmp);
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = ''; p.stderr.on('data', d => { e = (e + d).slice(-300); });
    p.on('error', reject); p.on('close', c => (c === 0 ? resolve() : reject(new Error('ffmpeg ' + c + ': ' + e))));
  });
  await fs.rename(tmp, file);
}

// Captions as plain text (the song's words) for the audio file's lyrics tag.
export function lyricsText(captions) {
  return captions.map(c => {
    const lines = []; let last = '';
    for (const raw of require('node:fs').readFileSync(c.file, 'utf8').split(/\r?\n/)) {
      const t = raw.trim();
      if (!t || /^\d+$/.test(t) || /-->/.test(t)) continue;
      const clean = t.replace(/<[^>]+>/g, '').trim();
      if (clean && clean !== last) lines.push(clean);
      last = clean;
    }
    return (captions.length > 1 ? '[' + (NAMES[c.lang.slice(0, 2)] || c.lang) + ']\n' : '') + lines.join('\n');
  }).join('\n\n').slice(0, 20000);
}
