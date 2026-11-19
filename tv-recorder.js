// Owner, 19.11: replays of the live channels by hour, around the clock (5/9).
// Every channel is recorded all the time into 10-minute files named by the
// Israel-time minute they start (YYYYMMDD-HHMMSS.mp3, mono 16 kHz, 32 kbps:
// ~14 MB an hour a channel). The last 26 hours are kept; older files are
// deleted, and the oldest go first if the disk runs low. A recording that
// stops (stream ended, address expired, stuck) is restarted with a fresh
// address from the channel's page.
import { spawn } from 'node:child_process';
import { promises as fs, existsSync, statfsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStreamInfo, ffmpegHeaderArgs, SYSTEM_FFMPEG } from './live-relay.js';

export const REC_DIR = process.env.TV_REC_DIR || path.join(os.homedir(), 'yemot-tv-rec');
const KEEP_MS = 26 * 3600 * 1000;
const MIN_FREE = 2 * 1024 ** 3, WANT_FREE = 3 * 1024 ** 3;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export const recStatus = {}; // key -> { title, state, since, restarts, error, lastFile }

// Israel date and hour of a moment.
export function israelParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { ymd: p.year + p.month + p.day, hour: Number(p.hour) % 24 };
}

// The most recent occurrence of `hour` (00-23): today when it has begun,
// otherwise yesterday.
export function targetDay(hour, now = new Date()) {
  const t = israelParts(now);
  return hour <= t.hour ? t.ymd : israelParts(new Date(now.getTime() - 24 * 3600 * 1000)).ymd;
}

// The recorded files of one channel for that hour, in order.
export async function filesForHour(key, hour, now = new Date(), dir = REC_DIR) {
  const day = targetDay(hour, now), hh = String(hour).padStart(2, '0');
  const names = await fs.readdir(path.join(dir, key)).catch(() => []);
  return names.filter(n => n.startsWith(day + '-' + hh) && n.endsWith('.mp3')).sort().map(n => path.join(dir, key, n));
}

// The hours (of the last 24) that have something recorded for a channel.
export async function hoursAvailable(key, now = new Date(), dir = REC_DIR) {
  const names = await fs.readdir(path.join(dir, key)).catch(() => []);
  const out = [];
  for (let h = 0; h < 24; h++) {
    const day = targetDay(h, now), hh = String(h).padStart(2, '0');
    if (names.some(n => n.startsWith(day + '-' + hh))) out.push(h);
  }
  return out;
}

async function cleanup(log) {
  const all = [];
  for (const key of await fs.readdir(REC_DIR).catch(() => [])) {
    for (const n of await fs.readdir(path.join(REC_DIR, key)).catch(() => [])) {
      const f = path.join(REC_DIR, key, n);
      const st = await fs.stat(f).catch(() => null);
      if (st) all.push({ f, t: st.mtimeMs });
    }
  }
  let removed = 0;
  for (const x of all) if (Date.now() - x.t > KEEP_MS) { await fs.unlink(x.f).catch(() => {}); removed++; }
  // Low disk: the oldest recordings go first, so the server never fills up.
  const free = () => { try { const s = statfsSync(REC_DIR); return s.bavail * s.bsize; } catch { return Infinity; } };
  if (free() < MIN_FREE) {
    for (const x of all.filter(x => existsSync(x.f)).sort((a, b) => a.t - b.t)) {
      if (free() >= WANT_FREE) break;
      await fs.unlink(x.f).catch(() => {}); removed++;
    }
  }
  if (removed) log.info?.('[TV REC] old recordings removed', { removed });
  return free();
}

function newestFile(dir) {
  return fs.readdir(dir).then(async ns => {
    let best = null;
    for (const n of ns) { const st = await fs.stat(path.join(dir, n)).catch(() => null); if (st && (!best || st.mtimeMs > best.t)) best = { n, t: st.mtimeMs, size: st.size }; }
    return best;
  }).catch(() => null);
}

// deps: { channels, findSource(ch, {fresh}), ffmpegPath, log }
export function startRecorders(deps) {
  const log = deps.log || console;
  if (String(process.env.TV_RECORD || 'on').toLowerCase() === 'off') { log.info?.('[TV REC] off (TV_RECORD=off)'); return; }
  try { mkdirSync(REC_DIR, { recursive: true }); } catch (e) { log.warn?.('[TV REC] no folder for recordings', { message: String(e?.message || e) }); return; }
  const bin = [...SYSTEM_FFMPEG.filter(b => existsSync(b)), deps.ffmpegPath].filter(Boolean)[0];
  let lowDisk = false;
  const tidy = async () => { const free = await cleanup(log).catch(() => Infinity); lowDisk = free < MIN_FREE; };
  tidy(); setInterval(tidy, 10 * 60 * 1000).unref?.();

  deps.channels.forEach((ch, i) => {
    const st = recStatus[ch.key] = { title: ch.title, state: 'starting', since: null, restarts: 0, error: null, lastFile: null };
    const dir = path.join(REC_DIR, ch.key);
    mkdirSync(dir, { recursive: true });
    let fails = 0;
    const run = async () => {
      if (lowDisk) { st.state = 'paused: disk low'; return setTimeout(run, 10 * 60 * 1000).unref?.(); }
      const src = await deps.findSource(ch, { fresh: st.restarts > 0 }).catch(() => ({ page: null }));
      const info = src?.page ? await resolveStreamInfo(src.page, { impersonate: !!src.impersonate, referer: src.referer || null }).catch(() => null) : null;
      if (!info?.url) {
        st.state = 'no source'; st.error = info?.error || null;
        fails++; return setTimeout(run, Math.min(30, 2 * fails) * 60 * 1000).unref?.();
      }
      const hdr = ffmpegHeaderArgs({ 'User-Agent': UA, ...(src.referer ? { Referer: src.referer } : {}), ...(info.headers || {}) });
      const args = ['-hide_banner', '-loglevel', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10', ...hdr,
        '-i', info.url, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k',
        '-f', 'segment', '-segment_time', '600', '-segment_atclocktime', '1', '-strftime', '1', '-reset_timestamps', '1',
        path.join(dir, '%Y%m%d-%H%M%S.mp3')];
      const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TZ: 'Asia/Jerusalem' } });
      st.state = 'recording'; st.since = new Date().toISOString(); st.error = null;
      let err = ''; const t0 = Date.now();
      p.stderr.on('data', d => { err = (err + d).slice(-300); });
      // Stuck stream: no new audio for 2 minutes -> restart.
      const watch = setInterval(async () => {
        const nf = await newestFile(dir);
        if (nf) st.lastFile = nf.n;
        if (Date.now() - t0 > 150000 && (!nf || Date.now() - nf.t > 120000)) { st.error = 'stuck'; p.kill('SIGKILL'); }
        else fails = 0;
      }, 60000);
      watch.unref?.();
      p.on('error', e => { st.error = String(e?.message || e).slice(0, 160); });
      p.on('close', (code, sig) => {
        clearInterval(watch);
        st.restarts++; st.state = 'restarting'; st.error = st.error || (err.trim().split('\n').pop() || ('exit ' + (sig || code))).slice(0, 200);
        log.warn?.('[TV REC] recording stopped; restarting', { key: ch.key, code, signal: sig, err: st.error });
        fails++; setTimeout(run, Math.min(10, fails) * 15000).unref?.();
      });
    };
    // Staggered, after the app has settled.
    setTimeout(run, 120000 + i * 15000).unref?.();
  });
  log.info?.('[TV REC] recorders starting', { channels: deps.channels.length, dir: REC_DIR, engine: bin });
}
