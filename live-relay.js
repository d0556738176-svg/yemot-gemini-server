// Live broadcasts from YouTube and other websites over the phone (owner, 18.11).
// Yemot cannot play an internet stream by itself, so this server listens to
// the stream and cuts it into short pieces (WAV, the phone format), uploads
// each piece to Yemot as soon as it is done, and the call plays the pieces one
// after another: the caller hears the broadcast about half a minute behind.
// One relay per broadcast, shared by every caller on it; it stops by itself a
// few minutes after the last caller leaves, and after a hard limit.
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ytdlpPath } from './youtube-direct.js';

export const SEG_SEC = 20;
const IDLE_MS = 3 * 60 * 1000, MAX_MS = 4 * 3600 * 1000, KEEP = 12;
const relays = new Map();
export const liveIdFor = url => 'l' + createHash('sha1').update(String(url)).digest('hex').slice(0, 10);

// The stream address the page plays (YouTube live, HLS, Icecast...).
export function resolveStream(url, { bin = ytdlpPath(), timeoutMs = 45000, impersonate = false } = {}) {
  return new Promise(resolve => {
    if (/\.(?:m3u8|mp3|aac|ogg|opus)(?:\?|$)/i.test(url)) return resolve(url);
    const p = spawn(bin, ['--no-warnings', '-g', '-f', 'bestaudio/best[height<=480]/best', '--no-playlist', ...(impersonate ? ['--impersonate', 'chrome'] : []), '--', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', c => { clearTimeout(t); resolve(c === 0 ? out.trim().split('\n')[0] || null : null); });
  });
}

// deps: { ffmpegPath, upload(file, remote), del(remote), log }
export function startRelay(item, deps) {
  const id = liveIdFor(item.url);
  const old = relays.get(id);
  if (old && !old.stopped) { old.touch(); return old; }
  const log = deps.log || console;
  const dir = path.join(os.tmpdir(), 'live-' + id);
  const r = { id, title: item.title, url: item.url, pieces: [], next: 0, stopped: false, error: null, startedAt: Date.now(), lastSeen: Date.now(), proc: null };
  r.touch = () => { r.lastSeen = Date.now(); };
  r.stop = why => {
    if (r.stopped) return;
    r.stopped = true; r.error = r.error || why;
    try { r.proc?.kill('SIGKILL'); } catch {}
    clearInterval(r.timer);
    log.info?.('[LIVE] relay stopped', { id, why, pieces: r.next });
    setTimeout(async () => {
      for (const p of r.pieces) await deps.del?.(p.remote).catch?.(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (relays.get(id) === r) relays.delete(id);
    }, 60000).unref?.();
  };
  relays.set(id, r);
  (async () => {
    await fs.mkdir(dir, { recursive: true });
    let restarts = 0;
    while (!r.stopped && restarts < 6) {
      const src = await resolveStream(item.url, { impersonate: !!item.impersonate });
      if (!src) { r.error = 'no_stream'; if (++restarts >= 3) break; await new Promise(x => setTimeout(x, 5000)); continue; }
      const startNo = r.next;
      const args = ['-hide_banner', '-loglevel', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
        '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-af', 'loudnorm=I=-16:TP=-2',
        '-f', 'segment', '-segment_time', String(SEG_SEC), '-segment_start_number', String(startNo), '-reset_timestamps', '1', path.join(dir, '%03d.wav')];
      log.info?.('[LIVE] relay listening', { id, restart: restarts });
      await new Promise(res => {
        r.proc = spawn(deps.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        r.proc.stderr.on('data', d => { err = (err + d).slice(-300); });
        r.proc.on('error', res);
        r.proc.on('close', c => { if (!r.stopped) log.warn?.('[LIVE] stream ended', { id, code: c, err: err.trim().slice(-160) }); res(); });
      });
      restarts++;
      if (!r.stopped) await new Promise(x => setTimeout(x, 3000));
    }
    r.stop(r.error || 'stream_ended');
  })().catch(e => { r.error = 'relay_failed'; log.warn?.('[LIVE] relay failed', { id, message: String(e?.message || e).slice(0, 160) }); r.stop('relay_failed'); });

  // A piece is finished when the next one has started: then it is uploaded.
  let busy = false;
  r.timer = setInterval(async () => {
    if (busy || r.stopped) return;
    if (Date.now() - r.lastSeen > IDLE_MS) return r.stop('no_listeners');
    if (Date.now() - r.startedAt > MAX_MS) return r.stop('time_limit');
    busy = true;
    try {
      const names = (await fs.readdir(dir).catch(() => [])).filter(n => /^\d{3}\.wav$/.test(n)).sort();
      for (const n of names.slice(0, -1)) {
        const no = Number(n.slice(0, 3)), file = path.join(dir, n);
        const remote = 'ivr2:/2/live/' + id + '/' + n;
        try { await deps.upload(file, remote); r.pieces.push({ no, remote, play: '/2/live/' + id + '/' + n.slice(0, 3) }); r.next = Math.max(r.next, no + 1); }
        catch (e) { log.warn?.('[LIVE] upload failed', { id, no, message: String(e?.message || e).slice(0, 120) }); }
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
export const _relays = relays;
export const _exists = existsSync;
