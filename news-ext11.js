// Owner, 25.11: extension 11 = news. 11/1 holds every new video of the
// Israeli news channels on YouTube (short, long, shorts, finished live
// broadcasts), newest first, the moment it can be downloaded.
//   /11      menu (api): 1 = the latest news, 2-9 = archives (when they exist)
//   /11/1    playfile, start=max: the newest file first. Keys like extension 7
//            (1 +10s, 3 -10s, 4 older, 6 newer, 7 +3 min, 5 pause, * star menu,
//            8 details, 9 Hebrew dubbing saved to extension 7) plus
//            2 = delete this file (1 = confirm, 2 = cancel); 0 = back to /11,
//            # = main menu.
// Every file: downloaded on our server (free path only, never the paid
// engine), mastered at the owner's phone spec (WAV 16 kHz mono 16-bit, speech:
// low cut 100 Hz, gentle noise reduction, peak -2 dB), uploaded to Yemot and
// deleted from the server at once. Files are kept until the owner deletes them.
// A Yemot playfile folder numbers files 000-999: when 11/1 is full, its older
// half moves to an archive folder (11/2, 11/3 ... 11/9) and the newer half
// moves down, so 11/1 always has room for the newest.
import { spawn } from 'node:child_process';
import { promises as fs, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLAY_KEYS } from './branch2-ext7.js';

// id: the channel id when known (checked: 25.11); handle: resolved on the
// server. A channel with both is watched on both when they differ.
export const NEWS_CHANNELS = [
  { key: 'kan', title: 'כאן חדשות', id: 'UC_HwfTAcjBESKZRJq6BTCpg', handle: 'KAN11NEWS' },
  { key: '13', title: 'חדשות 13', id: 'UCvQmPpU20hw1Trss_CVwaew' },
  { key: '14', title: 'עכשיו 14', id: 'UCKEImtWikw9usC1pl_9m1nQ', handle: 'c14news' },
  { key: 'i24', title: 'i24NEWS בעברית', id: 'UCisowXt5wZkp2sR3rFh9lnQ' },
  { key: '12', title: 'חדשות 12', handle: 'israelnews' },
  { key: 'kikar', title: 'כיכר השבת', handle: 'kikarhashabat' },
  { key: 'knesset', title: 'ערוץ כנסת', handle: 'KnessetTV' },
];

export const NEWS_ROOT = '/11';
export const NEWS_DIR = '/11/1';
export const INDEX = 'ivr2:/2/youtubeaudio/news11_index.json';
export const MAX_FILES = 1000; // 000-999 in one playfile folder
export const FIRST_ARCHIVE = 2, LAST_ARCHIVE = 9;
export const NEWS_MARK = 'news11=yes';
const STATE_DIR = process.env.NEWS_STATE_DIR || path.join(os.homedir(), 'yemot-news');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

export const file3 = n => String(n).padStart(3, '0');
export const archiveDir = n => NEWS_ROOT + '/' + n;

// ---- Yemot settings ----
export function playIni(publicUrl, dir, title) {
  const keys = { ...PLAY_KEYS };
  keys.control_play2 = 'send_api'; // delete this file (asks 1 / 2 first)
  keys.control_play0 = 'go_to_folder';
  keys.playfile_control_play_0_goto = NEWS_ROOT;
  keys['control_play#'] = 'go_to_folder';
  keys['playfile_control_play_#_goto'] = '/';
  return ['type=playfile', 'title=' + title, 'start=max', 'save_last_play=yes',
    'api_link=' + String(publicUrl || '').replace(/\/$/, '') + '/yemot-media',
    ...Object.entries(keys).map(([k, v]) => k + '=' + v), NEWS_MARK].join('\n') + '\n';
}
export function menuIni(publicUrl) {
  return ['type=api', 'api_link=' + String(publicUrl || '').replace(/\/$/, '') + '/yemot-youtube', 'api_add_0=news=menu', 'title=חדשות', NEWS_MARK].join('\n') + '\n';
}

// ---- Feeds ----
const ent = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&').trim();
export function parseFeed(xml) {
  const out = [];
  const channelTitle = ent((/<feed[\s\S]*?<title>([\s\S]*?)<\/title>/.exec(String(xml || '')) || [])[1]);
  for (const m of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const videoId = (/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/.exec(e) || [])[1];
    if (!videoId) continue;
    out.push({ videoId, title: ent((/<title>([\s\S]*?)<\/title>/.exec(e) || [])[1]),
      published: (/<published>([^<]+)<\/published>/.exec(e) || [])[1] || null,
      short: /\/shorts\//.test((/<link[^>]*href="([^"]+)"/.exec(e) || [])[1] || '') });
  }
  return { channelTitle, items: out };
}
export const feedUrl = id => 'https://www.youtube.com/feeds/videos.xml?channel_id=' + id;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// The channel id behind a handle (the channel page names it).
export async function resolveHandle(handle, fetchImpl = fetch) {
  const r = await fetchImpl('https://www.youtube.com/@' + encodeURIComponent(handle), { headers: { 'user-agent': UA, 'accept-language': 'he,en;q=0.8', cookie: 'CONSENT=YES+1' }, signal: AbortSignal.timeout(20000) });
  const html = await r.text();
  const id = (/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/.exec(html) || /"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(html) || /"channelId":"(UC[A-Za-z0-9_-]{22})"/.exec(html) || [])[1];
  return id || null;
}

// ---- Local state (a small list, never media) ----
export function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
export function saveState(s) { try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s)); renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch {} }

export const status = { started: null, lastPoll: null, channels: {}, queue: [], working: {}, log: [], rotation: null, first: null };
const note = x => { status.log.unshift({ at: new Date().toISOString(), ...x }); status.log.length = Math.min(status.log.length, 60); };

// One round over every channel. New videos are queued; the first round ever
// takes only what came out in the last 2 hours (not the channels' history).
export async function pollOnce(deps, now = Date.now()) {
  const st = loadState();
  st.seen ||= {}; st.queue ||= {}; st.ids ||= {};
  const firstRun = !st.started;
  if (firstRun) st.started = new Date(now).toISOString();
  for (const ch of NEWS_CHANNELS) {
    const row = status.channels[ch.key] ||= { title: ch.title };
    let ids = st.ids[ch.key];
    if (!ids || !ids.length || (st.idsAt?.[ch.key] || 0) < now - 24 * 3600e3) {
      const set = new Set(ch.id ? [ch.id] : []);
      if (ch.handle) { const r = await resolveHandle(ch.handle, deps.fetch).catch(e => { row.resolveError = String(e?.message || e).slice(0, 100); return null; }); if (r) set.add(r); }
      if (set.size) { ids = [...set]; st.ids[ch.key] = ids; (st.idsAt ||= {})[ch.key] = now; }
    }
    row.ids = ids || [];
    for (const id of ids || []) {
      try {
        const r = await deps.fetch(feedUrl(id), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('feed HTTP ' + r.status);
        const feed = parseFeed(await r.text());
        (row.feedTitles ||= {})[id] = feed.channelTitle;
        row.lastOk = new Date(now).toISOString(); row.error = null; row.latest = feed.items[0]?.title || null;
        for (const it of feed.items) {
          if (st.seen[it.videoId] || st.queue[it.videoId]) continue;
          const age = now - (Date.parse(it.published) || now);
          if (firstRun && age > 2 * 3600e3) { st.seen[it.videoId] = 'before-start'; continue; }
          if (age > 7 * 86400e3) { st.seen[it.videoId] = 'old'; continue; }
          st.queue[it.videoId] = { ch: ch.key, chTitle: ch.title, ytChannel: feed.channelTitle || null, title: it.title, published: it.published, short: it.short, tries: 0, nextAt: 0, added: new Date(now).toISOString() };
          note({ queued: it.videoId, ch: ch.key, title: it.title.slice(0, 80) });
        }
      } catch (e) { row.error = String(e?.message || e).slice(0, 120); }
    }
  }
  // Keep the seen list bounded.
  const seen = Object.entries(st.seen);
  if (seen.length > 6000) st.seen = Object.fromEntries(seen.slice(-4000));
  saveState(st);
  status.lastPoll = new Date(now).toISOString();
  status.queue = Object.entries(st.queue).map(([v, q]) => ({ videoId: v, ch: q.ch, title: q.title?.slice(0, 80), tries: q.tries, wait: q.wait || null }));
  return Object.keys(st.queue).length;
}

// ---- The index of what is in Yemot ----
async function readIndex(io) { return (await io.readJson(INDEX).catch(() => null)) || { version: 1, next: 0, items: {}, archives: 0 }; }
let chain = Promise.resolve();
const serial = fn => { const j = chain.then(fn); chain = j.catch(() => {}); return j; };

// Lookup for keys 8/9/2: which video a file in /11 is.
export async function lookupNews(dir, file, io) {
  dir = String(dir || '').replace(/\/$/, '');
  if (!dir.startsWith(NEWS_ROOT + '/')) return null;
  const idx = await readIndex(io);
  for (const [videoId, e] of Object.entries(idx.items || {})) if (e.dir === dir && e.file === String(file)) return { videoId, title: e.title || '', dub: false, channel: e.ytChannel || e.chTitle || '' };
  return null;
}

// Key 2 (confirmed): the file is deleted from Yemot and from the index. The
// answer is where to play next: the next older file, else the next newer one.
export function deleteNews(dir, file, io) {
  return serial(async () => {
    dir = String(dir || '').replace(/\/$/, '');
    if (!dir.startsWith(NEWS_ROOT + '/') || !/^\d{3}$/.test(String(file))) throw new Error('not a news file');
    await io.del('ivr2:' + dir + '/' + file + '.wav');
    const idx = await readIndex(io);
    let videoId = null;
    for (const [v, e] of Object.entries(idx.items || {})) if (e.dir === dir && e.file === String(file)) videoId = v;
    if (videoId) { delete idx.items[videoId]; await io.writeJson(INDEX, idx); }
    const nums = Object.values(idx.items || {}).filter(e => e.dir === dir).map(e => Number(e.file)).sort((a, b) => a - b);
    const n = Number(file);
    const older = nums.filter(x => x < n).pop();
    const newer = nums.find(x => x > n);
    note({ deleted: dir + '/' + file, videoId });
    return { next: older !== undefined ? file3(older) : newer !== undefined ? file3(newer) : null, videoId };
  });
}

// 11/1 full: files 000-499 go to the next archive folder (same numbers), and
// 500-999 move down to 000-499.
export async function rotate(io, idx) {
  const a = (idx.archives || 0) + FIRST_ARCHIVE;
  if (a > LAST_ARCHIVE) throw Object.assign(new Error('all archive folders are full'), { code: 'news_full' });
  const target = archiveDir(a);
  status.rotation = { at: new Date().toISOString(), to: target, state: 'running' };
  await io.saveSettings(target, playIni(io.publicUrl, target, 'ארכיון חדשות ' + (a - 1)));
  const half = MAX_FILES / 2;
  for (let n = 0; n < half; n++) await io.move('ivr2:' + NEWS_DIR + '/' + file3(n) + '.wav', 'ivr2:' + target + '/' + file3(n) + '.wav').catch(() => {});
  for (let n = half; n < MAX_FILES; n++) await io.move('ivr2:' + NEWS_DIR + '/' + file3(n) + '.wav', 'ivr2:' + NEWS_DIR + '/' + file3(n - half) + '.wav').catch(() => {});
  for (const e of Object.values(idx.items || {})) {
    if (e.dir !== NEWS_DIR) continue;
    const n = Number(e.file);
    if (n < half) e.dir = target; else e.file = file3(n - half);
  }
  idx.archives = a - FIRST_ARCHIVE + 1;
  idx.next = Math.max(0, (idx.next || MAX_FILES) - half);
  await io.writeJson(INDEX, idx);
  status.rotation.state = 'done';
  note({ rotated: target });
  return idx;
}

// Uploads one prepared phone file under the next number of 11/1.
export function publishNews(videoId, wav, meta, io) {
  return serial(async () => {
    let idx = await readIndex(io);
    if (idx.items?.[videoId]) return idx.items[videoId];
    if ((idx.next || 0) >= MAX_FILES) idx = await rotate(io, idx);
    const n = idx.next || 0;
    const file = file3(n);
    // The number is reserved first: a failure leaves a gap, never two on one.
    idx.next = n + 1;
    await io.writeJson(INDEX, idx);
    await io.saveSettings(NEWS_DIR, playIni(io.publicUrl, NEWS_DIR, 'חדשות מעודכנות'));
    let last = null;
    for (const w of io.retryWaits || [0, 15000, 45000, 120000]) {
      if (w) await new Promise(r => setTimeout(r, w));
      try { await io.upload(wav, 'ivr2:' + NEWS_DIR + '/' + file + '.wav'); last = null; break; }
      catch (e) { last = e; }
    }
    if (last) throw last;
    const fresh = await readIndex(io);
    fresh.next = Math.max(fresh.next || 0, n + 1);
    fresh.items = { ...(fresh.items || {}), [videoId]: { dir: NEWS_DIR, file, title: String(meta.title || '').slice(0, 160), ch: meta.ch, chTitle: meta.chTitle, ytChannel: meta.ytChannel || null, published: meta.published, at: new Date().toISOString(), minutes: meta.minutes } };
    await io.writeJson(INDEX, fresh);
    return fresh.items[videoId];
  });
}

// ---- Live check (yt-dlp, no download) ----
export function parseProbe(out) {
  const line = String(out || '').trim().split('\n').filter(Boolean).pop() || '';
  const [live, dur] = line.split('|');
  return { live: live || 'unknown', durationSec: Number(dur) > 0 ? Number(dur) : null };
}
export function probeVideo(videoId, bin, timeoutMs = 60000) {
  return new Promise(resolve => {
    const p = spawn(bin, ['--skip-download', '--no-warnings', '--no-playlist', '--print', '%(live_status)s|%(duration)s', 'https://www.youtube.com/watch?v=' + videoId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', d => { o += d; }); p.stderr.on('data', d => { e = (e + d).slice(-400); });
    p.on('error', () => { clearTimeout(t); resolve({ live: 'error', error: 'yt-dlp not runnable' }); });
    // A broadcast that has not started yet is an error for yt-dlp ("This live
    // event will begin in a few moments", "Premieres in 10 minutes"): it waits.
    p.on('close', c => { clearTimeout(t); const err = e.trim().split('\n').pop()?.slice(0, 160) || 'exit ' + c;
      resolve(c === 0 ? parseProbe(o) : /live event will begin|premieres? in|will begin in|is_upcoming|scheduled to start/i.test(e) ? { live: 'is_upcoming', error: err } : { live: 'error', error: err }); });
  });
}

// ---- The worker: two lanes, so a 4-hour Knesset session never holds up a
// one-minute news item. ----
const LONG_SEC = 20 * 60;
const busy = { short: false, long: false };
export async function workOnce(deps, now = Date.now()) {
  const st = loadState(); st.queue ||= {}; st.seen ||= {};
  const due = Object.entries(st.queue).filter(([, q]) => (q.nextAt || 0) <= now)
    .sort((a, b) => (Date.parse(a[1].published) || 0) - (Date.parse(b[1].published) || 0));
  const started = [];
  for (const [videoId, q] of due) {
    if (status.working[videoId]) continue;
    const lane = q.durationSec && q.durationSec > LONG_SEC ? 'long' : 'short';
    if (busy[lane]) continue;
    busy[lane] = true; status.working[videoId] = { lane, since: new Date().toISOString(), title: q.title?.slice(0, 80) };
    started.push(runOne(videoId, q, lane, deps).finally(() => { busy[lane] = false; delete status.working[videoId]; }));
  }
  // Not awaited by the timer: a long job never stops new short ones starting.
  return { count: started.length, done: Promise.all(started) };
}

function update(videoId, fn) { const st = loadState(); st.queue ||= {}; st.seen ||= {}; fn(st); saveState(st); }
const retryLater = (videoId, mins, why, extra = {}) => update(videoId, st => { const q = st.queue[videoId]; if (!q) return; Object.assign(q, extra); q.tries = (q.tries || 0) + 1; q.wait = why; q.nextAt = Date.now() + mins * 60000; });

async function runOne(videoId, q, lane, deps) {
  const log = deps.log || console;
  // 1. Is it a broadcast still on the air (or not started)? Then later.
  const pr = await deps.probe(videoId);
  if (pr.durationSec) update(videoId, st => { if (st.queue[videoId]) st.queue[videoId].durationSec = pr.durationSec; });
  if (['is_live', 'is_upcoming', 'post_live'].includes(pr.live)) {
    const age = Date.now() - (Date.parse(q.published) || Date.now());
    if (age > 3 * 86400e3) { update(videoId, st => { delete st.queue[videoId]; st.seen[videoId] = 'live-too-long'; }); return; }
    retryLater(videoId, 10, pr.live); return;
  }
  if (pr.live === 'error') {
    if ((q.tries || 0) >= 12) { update(videoId, st => { delete st.queue[videoId]; st.seen[videoId] = 'unavailable'; }); note({ gaveUp: videoId, why: pr.error }); return; }
    retryLater(videoId, Math.min(60, 5 * 2 ** Math.min(4, q.tries || 0)), 'check failed: ' + (pr.error || '')); return;
  }
  // A long one that came to the short lane goes to the long lane (next round).
  if (lane === 'short' && pr.durationSec > LONG_SEC) { update(videoId, st => { if (st.queue[videoId]) st.queue[videoId].nextAt = 0; }); return; }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'news11-'));
  const t0 = Date.now();
  try {
    const src = path.join(tmp, 'source');
    await deps.download(videoId, src);
    const wav = path.join(tmp, 'phone.wav');
    const m = await deps.master(src, wav, q.title);
    await fs.rm(src, { force: true }).catch(() => {});
    const entry = await deps.publish(videoId, wav, { title: q.title, ch: q.ch, chTitle: q.chTitle, ytChannel: q.ytChannel, published: q.published, minutes: Math.round((m?.durationSec || pr.durationSec || 0) / 60) });
    update(videoId, st => { delete st.queue[videoId]; st.seen[videoId] = 'done'; });
    note({ done: videoId, ch: q.ch, file: entry?.file, title: q.title?.slice(0, 80), seconds: Math.round((Date.now() - t0) / 1000), lateMin: Math.round((Date.now() - (Date.parse(q.published) || Date.now())) / 60000) });
    log.info?.('[NEWS11] published', { videoId, ch: q.ch, file: entry?.file });
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 200);
    note({ failed: videoId, ch: q.ch, error: msg });
    log.warn?.('[NEWS11] not published; tried again later', { videoId, message: msg });
    if ((q.tries || 0) >= 8) update(videoId, st => { delete st.queue[videoId]; st.seen[videoId] = 'failed'; });
    else retryLater(videoId, Math.min(120, 5 * 2 ** Math.min(5, q.tries || 0)), 'failed: ' + msg.slice(0, 80));
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

export function _resetForTests() { busy.short = busy.long = false; status.working = {}; status.log.length = 0; chain = Promise.resolve(); }
