// Live broadcasts from YouTube and other websites over the phone (owner, 18.11).
// Yemot cannot play an internet stream by itself, so this server listens to
// the stream and cuts it into short pieces (WAV, the phone format), uploads
// each piece to Yemot as soon as it is done, and the call plays the pieces one
// after another: the caller hears the broadcast about half a minute behind.
// One relay per broadcast, shared by every caller on it; it stops by itself a
// few minutes after the last caller leaves, and after a hard limit.
import { spawn } from 'node:child_process';
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ytdlpPath } from './youtube-direct.js';

export const SEG_SEC = 20;
// Owner, 19.11: no time limit on a live broadcast (it still stops a few
// minutes after the last caller leaves). LIVE_MAX_HOURS can set one again.
const IDLE_MS = 3 * 60 * 1000, MAX_MS = (Number(process.env.LIVE_MAX_HOURS) || 0) * 3600 * 1000, KEEP = 12;
const relays = new Map();
export const SYSTEM_FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
// The last relays that stopped, for the status page. Kept in a file too, so
// an app restart (an update) does not wipe what happened in the last calls.
const HISTORY_FILE = path.join(os.tmpdir(), 'yemot-live-history.json');
const history = (() => { try { const j = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); return Array.isArray(j) ? j.slice(0, 20) : []; } catch { return []; } })();
function saveHistory() { try { writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 20))); } catch {} }
export const relayHistory = () => history;
// Call-side events of the TV menu (channel chosen, what the caller was told).
export function noteCall(event) { history.unshift({ at: new Date().toISOString(), call: true, ...event }); history.length = Math.min(history.length, 20); saveHistory(); }
export const liveIdFor = url => 'l' + createHash('sha1').update(String(url)).digest('hex').slice(0, 10);

// The stream address the page plays (YouTube live, HLS, Icecast...).
export async function resolveStream(url, opts = {}) {
  const info = await resolveStreamInfo(url, opts);
  return info?.url || null;
}
// The address and the request headers the broadcaster's server expects
// (User-Agent, Referer, Origin, cookies the extractor got). Many live streams
// answer 403 to a request without them, which was a cause of failed relays.
export function resolveStreamInfo(url, { bin = ytdlpPath(), timeoutMs = 45000, impersonate = false, referer = null } = {}) {
  return new Promise(resolve => {
    if (/\.(?:m3u8|mp3|aac|ogg|opus)(?:\?|$)/i.test(url)) return resolve({ url, headers: referer ? { Referer: referer } : {} });
    const p = spawn(bin, ['--no-warnings', '-j', '-f', 'bestaudio/best[height<=480]/best', '--no-playlist', ...(impersonate ? ['--impersonate', 'chrome'] : []), ...(referer ? ['--referer', referer] : []), '--', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', d => { out += d; if (out.length > 20e6) p.kill('SIGKILL'); });
    p.stderr.on('data', d => { err = (err + d).slice(-400); });
    p.on('error', e => { clearTimeout(t); resolve({ url: null, error: String(e?.message || e).slice(0, 160) }); });
    p.on('close', c => {
      clearTimeout(t);
      if (c !== 0) return resolve({ url: null, error: err.trim().split('\n').pop()?.slice(0, 200) || 'exit ' + c });
      try {
        const j = JSON.parse(out);
        const u = j.url || (j.requested_formats || [])[0]?.url || null;
        const headers = { ...(j.http_headers || {}), ...((j.requested_formats || [])[0]?.http_headers || {}) };
        if (referer && !headers.Referer) headers.Referer = referer;
        resolve({ url: u, headers, live: !!(j.is_live || j.live_status === 'is_live') });
      } catch { resolve({ url: null, error: 'bad answer' }); }
    });
  });
}
export const ffmpegHeaderArgs = headers => {
  const keep = Object.entries(headers || {}).filter(([k, v]) => /^(user-agent|referer|origin|cookie|accept-language)$/i.test(k) && v && !/[\r\n]/.test(String(v)));
  return keep.length ? ['-headers', keep.map(([k, v]) => k + ': ' + v + '\r\n').join('')] : [];
};

// Letters and digits only: Yemot's play list reads '-' and '.' as separators
// (23.11: a '-' in the run name made every live piece unplayable).
export const runName = (id, now = Date.now()) => String(id).replace(/[^A-Za-z0-9]/g, '') + 'r' + now.toString(36);
export const piecePath = (run, n) => '/2/live/' + run + '/' + n;
// deps: { ffmpegPath, upload(file, remote), del(remote), log }
export function startRelay(item, deps) {
  const id = liveIdFor(item.url);
  const old = relays.get(id);
  if (old && !old.stopped) { old.touch(); return old; }
  const log = deps.log || console;
  // Every run of a channel has its own folder here and in Yemot (23.11): the
  // cleanup of a run that just stopped (a minute later) once deleted the
  // folder and the Yemot pieces of the next run of the same channel.
  // Letters and digits only: Yemot's play list reads '-' and '.' as separators
  // (23.11: a '-' here made every live piece unplayable).
  const run = runName(id);
  const dir = path.join(os.tmpdir(), 'live-' + run);
  const r = { id, title: item.title, url: item.url, pieces: [], next: 0, stopped: false, error: null, startedAt: Date.now(), lastSeen: Date.now(), proc: null, events: [] };
  // What happened, kept for the read-only status page (no keys, no tokens).
  r.note = (what, extra = {}) => { r.events.push({ at: new Date().toISOString(), what, ...extra }); if (r.events.length > 25) r.events.shift(); };
  r.touch = () => { r.lastSeen = Date.now(); };
  r.stop = why => {
    if (r.stopped) return;
    r.stopped = true; r.error = r.error || why;
    try { r.proc?.kill('SIGKILL'); } catch {}
    clearInterval(r.timer);
    log.info?.('[LIVE] relay stopped', { id, why, pieces: r.next });
    r.note('stopped', { why });
    history.unshift({ id, title: r.title, url: r.url, startedAt: new Date(r.startedAt).toISOString(), pieces: r.next, why, events: r.events.slice(-12) });
    history.length = Math.min(history.length, 20);
    saveHistory();
    setTimeout(async () => {
      for (const p of r.pieces) await deps.del?.(p.remote).catch?.(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (relays.get(id) === r) relays.delete(id);
    }, 60000).unref?.();
  };
  relays.set(id, r);
  (async () => {
    await fs.mkdir(dir, { recursive: true });
    let restarts = 0, src0 = item.url, ref0 = item.referer || null;
    // The audio engine: the server's own ffmpeg first (the bundled static one
    // crashes - SIGSEGV - on network streams, 18.11), the bundled one as backup.
    const bins = [...new Set([...SYSTEM_FFMPEG.filter(b => existsSync(b)), deps.ffmpegPath].filter(Boolean))];
    let binIdx = 0;
    while (!r.stopped && restarts < 6) {
      // After a drop, a fresh source address (addresses with a time-limited
      // token stop working; the channel's page gives a new one).
      if (restarts > 0 && item.refresh) {
        const fresh = await item.refresh().catch(() => null);
        if (fresh?.url) { src0 = fresh.url; ref0 = fresh.referer || ref0; r.note('source refreshed'); }
      }
      const info = await resolveStreamInfo(src0, { impersonate: !!item.impersonate, referer: ref0 });
      const src = info?.url;
      if (!src) { r.error = 'no_stream'; r.note('no stream', { reason: info?.error || null }); if (++restarts >= 3) break; await new Promise(x => setTimeout(x, 5000)); continue; }
      let host = ''; try { host = new URL(src).host; } catch {}
      r.note('stream found', { host, live: info.live ?? null, headers: Object.keys(info.headers || {}) });
      const startNo = r.next;
      // The broadcaster's own request headers (its player page, its user agent).
      const hdr = ffmpegHeaderArgs({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', ...(item.referer ? { Referer: item.referer } : {}), ...(info.headers || {}) });
      const args = ['-hide_banner', '-loglevel', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
        ...hdr, '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-af', item.af || 'loudnorm=I=-16:TP=-2',
        '-f', 'segment', '-segment_time', String(SEG_SEC), '-segment_start_number', String(startNo), '-reset_timestamps', '1', path.join(dir, '%03d.wav')];
      log.info?.('[LIVE] relay listening', { id, restart: restarts });
      await new Promise(res => {
        const bin = bins[binIdx];
        r.proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '', crashed = false;
        r.proc.stderr.on('data', d => { err = (err + d).slice(-300); });
        r.proc.on('error', e => { crashed = true; r.note('engine failed to start', { engine: bin, message: String(e?.message || e).slice(0, 120) }); });
        r.proc.on('close', (c, sig) => {
          if (!r.stopped) {
            log.warn?.('[LIVE] stream ended', { id, code: c, signal: sig, engine: bin, err: err.trim().slice(-160) });
            r.note('stream ended', { code: c, signal: sig || null, engine: bin, err: err.trim().slice(-200) });
          }
          if ((sig === 'SIGSEGV' || sig === 'SIGILL' || sig === 'SIGABRT' || sig === 'SIGBUS' || crashed) && binIdx < bins.length - 1) { binIdx++; r.engineSwitched = true; }
          res();
        });
      });
      if (r.engineSwitched) { r.engineSwitched = false; r.note('switched audio engine', { engine: bins[binIdx] }); continue; }
      restarts++;
      if (!r.stopped) await new Promise(x => setTimeout(x, 3000));
    }
    r.stop(r.error || 'stream_ended');
  })().catch(e => { r.error = 'relay_failed'; log.warn?.('[LIVE] relay failed', { id, message: String(e?.message || e).slice(0, 160) }); r.stop('relay_failed'); });

  // A piece is finished when the next one has started: then it is uploaded.
  let busy = false, beat = Date.now();
  r.timer = setInterval(async () => {
    if (busy || r.stopped) return;
    // A log line every minute while callers listen: the server's updater
    // restarts the app only after 90 quiet seconds, so it never cuts a listener.
    if (Date.now() - beat > 60000) { beat = Date.now(); log.info?.('[LIVE] relay on air', { id, pieces: r.next }); }
    if (Date.now() - r.lastSeen > IDLE_MS) return r.stop('no_listeners');
    if (MAX_MS && Date.now() - r.startedAt > MAX_MS) return r.stop('time_limit');
    busy = true;
    try {
      const names = (await fs.readdir(dir).catch(() => [])).filter(n => /^\d{3}\.wav$/.test(n)).sort();
      for (const n of names.slice(0, -1)) {
        const no = Number(n.slice(0, 3)), file = path.join(dir, n);
        const remote = 'ivr2:' + piecePath(run, n);
        // An empty piece (no sound came in that stretch) is not sent: Yemot
        // refuses it ("File upload expected") and it would only be silence.
        const size = (await fs.stat(file).catch(() => null))?.size || 0;
        if (size < 4000) { r.note('empty piece skipped', { no, bytes: size }); r.next = Math.max(r.next, no + 1); await fs.rm(file, { force: true }).catch(() => {}); continue; }
        try { await deps.upload(file, remote); r.pieces.push({ no, remote, play: piecePath(run, n).replace(/\.wav$/, '') }); r.next = Math.max(r.next, no + 1); }
        catch (e) { log.warn?.('[LIVE] upload failed', { id, no, message: String(e?.message || e).slice(0, 120) }); r.note('upload failed', { no, message: String(e?.message || e).slice(0, 120) }); }
        await fs.rm(file, { force: true }).catch(() => {});
      }
      while (r.pieces.length > KEEP) { const p = r.pieces.shift(); deps.del?.(p.remote)?.catch?.(() => {}); }
    } finally { busy = false; }
  }, 2000);
  r.timer.unref?.();
  return r;
}

// The next piece after `last` (or the newest one for a caller who just came).
// A caller who just came starts two pieces behind the newest, so the next
// piece is always ready before the one playing ends (no gaps).
export function nextPiece(r, last = null, { buffer = 2 } = {}) {
  if (last === null) return r.pieces.length > buffer ? r.pieces[r.pieces.length - 1 - buffer] : null;
  return r.pieces.find(p => p.no > last) || null;
}
// The pieces after `first` that are already in Yemot, played together in one
// prompt (no pause between them): up to `max`.
export function followingPieces(r, first, max = 3) {
  const out = [first];
  for (const p of r.pieces) if (p.no > out[out.length - 1].no && p.no === out[out.length - 1].no + 1 && out.length < max) out.push(p);
  return out;
}
// Check only (status page): plays `sec` seconds of a stream through the same
// engine and filter as the relay, to nowhere. Nothing is uploaded or kept.
export async function probeStream(url, { referer = null, impersonate = false, af = 'loudnorm=I=-16:TP=-2', sec = 8, ffmpegPath = null } = {}) {
  const info = await resolveStreamInfo(url, { impersonate, referer });
  if (!info?.url) return { ok: false, step: 'resolve', reason: info?.error || null };
  const bins = [...new Set([...SYSTEM_FFMPEG.filter(b => existsSync(b)), ffmpegPath].filter(Boolean))];
  const hdr = ffmpegHeaderArgs({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', ...(referer ? { Referer: referer } : {}), ...(info.headers || {}) });
  const tries = [];
  for (const bin of bins) {
    const t0 = Date.now();
    const out = await new Promise(res => {
      const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', ...hdr, '-i', info.url, '-vn', '-ac', '1', '-ar', '16000', '-af', af, '-t', String(sec), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let bytes = 0, err = '';
      const k = setTimeout(() => p.kill('SIGKILL'), (sec + 40) * 1000);
      p.stdout.on('data', d => { bytes += d.length; });
      p.stderr.on('data', d => { err = (err + d).slice(-200); });
      p.on('error', e => { clearTimeout(k); res({ code: null, signal: 'spawn', bytes, err: String(e?.message || e).slice(0, 120) }); });
      p.on('close', (code, signal) => { clearTimeout(k); res({ code, signal, bytes, err: err.trim() }); });
    });
    const audioSec = Math.round(out.bytes / 32000 * 10) / 10;
    tries.push({ engine: bin, ...out, audioSec, tookSec: Math.round((Date.now() - t0) / 1000) });
    if (audioSec >= sec * 0.8) return { ok: true, engine: bin, audioSec, tries };
  }
  return { ok: false, step: 'audio', tries };
}
export const _relays = relays;
export const _exists = existsSync;
