// Owner, 19.11: every hour of every channel is uploaded to Yemot by itself
// when the hour ends, and kept for good (never deleted). The newest
// broadcast of an hour plays first, then the days before it.
//   folder: ivr2:/5/9/<channel>/<HH>   one file per day: 000.wav (first day),
//   001.wav (next day)... ; start=max = the newest first, going back in days.
// Keys exactly like extension 7: 1 +10s, 3 -10s, 4 = the day before,
// 6 = the day after, 7 +3 min, 5 pause; 0 = back to the hours, # = main menu.
// Each hour is one file mastered like the downloads (WAV 16 kHz mono 16-bit,
// low cut 100 Hz, gentle noise reduction, peak -2 dB); Yemot joins a big
// file sent in parts. One hour is published at a time, to keep the server light.
import { spawn } from 'node:child_process';
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLAY_KEYS } from './branch2-ext7.js';
import { REC_DIR, masterSpeech, israelParts } from './tv-recorder.js';
import { SYSTEM_FFMPEG } from './live-relay.js';

const STATE_FILE = path.join(REC_DIR, 'published.json');
const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = s => { try { writeFileSync(STATE_FILE, JSON.stringify(s)); } catch {} };

export const replayLog = []; // last publications (ok / error), for the status page
const note = x => { replayLog.unshift({ at: new Date().toISOString(), ...x }); replayLog.length = Math.min(replayLog.length, 40); };

export const hourFolder = (key, hour) => 'ivr2:/5/9/' + key + '/' + String(hour).padStart(2, '0');

export function hourIni(key, title, hour) {
  const keys = { ...PLAY_KEYS };
  delete keys.control_play8; delete keys.control_play9; delete keys.api_hangup_send; // file details / dubbing: not for TV
  keys.control_play0 = 'go_to_folder';
  keys.playfile_control_play_0_goto = '/5/9/' + key;
  keys['control_play#'] = 'go_to_folder';
  keys['playfile_control_play_#_goto'] = '/';
  // start=max: the newest day of this hour first, then back day by day
  // (the same order extension 7 uses for the newest songs).
  return ['type=playfile', 'title=' + title + ' שעה ' + hour, 'start=max', ...Object.entries(keys).map(([k, v]) => k + '=' + v), 'ext5_tv=yes'].join('\n') + '\n';
}

// The hours of a channel that already have something in Yemot.
export function publishedHours(key) {
  const st = loadState();
  const out = new Set();
  for (const id of Object.keys(st.done || {})) { const m = id.match(/^(\d)\/\d{8}-(\d\d)$/); if (m && m[1] === key) out.add(Number(m[2])); }
  return [...out].sort((a, b) => a - b);
}

// Recorded hours that are over and not yet published: { ch, id, hour, files }.
export async function hoursToPublish(channels, now = new Date()) {
  const st = loadState(); const done = st.done || {};
  const cur = israelParts(now);
  const curId = cur.ymd + '-' + String(cur.hour).padStart(2, '0');
  const out = [];
  for (const ch of channels) {
    const names = await fs.readdir(path.join(REC_DIR, ch.key)).catch(() => []);
    const groups = {};
    for (const n of names) { const m = n.match(/^(\d{8})-(\d\d)\d{4}\.mp3$/); if (m) (groups[m[1] + '-' + m[2]] ||= []).push(n); }
    for (const [id, files] of Object.entries(groups)) {
      if (id >= curId) continue; // still being recorded
      if (done[ch.key + '/' + id]) continue;
      out.push({ ch, id, hour: Number(id.slice(9)), files: files.sort().map(n => path.join(REC_DIR, ch.key, n)) });
    }
  }
  out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Hours to make again in place (same file number), e.g. after a sound fix.
  for (const [k, number] of Object.entries(st.redo || {})) {
    const m = k.match(/^(\d)\/(\d{8}-(\d\d))$/); if (!m) continue;
    const ch = channels.find(c => c.key === m[1]); if (!ch) continue;
    const names = (await fs.readdir(path.join(REC_DIR, ch.key)).catch(() => [])).filter(n => n.startsWith(m[2]) && /\.mp3$/.test(n)).sort();
    if (!names.length) continue;
    out.push({ ch, id: m[2], hour: Number(m[3]), files: names.map(n => path.join(REC_DIR, ch.key, n)), number });
  }
  return out;
}

// Marks a channel's published hours whose recordings are still here, to be
// made again in place (owner, 21.11: channel 13's hiss). Returns how many.
export async function markRedo(key) {
  const st = loadState(); st.redo ||= {};
  const names = await fs.readdir(path.join(REC_DIR, key)).catch(() => []);
  let n = 0;
  for (const [id, d] of Object.entries(st.done || {})) {
    const m = id.match(/^(\d)\/(\d{8}-\d\d)$/);
    if (!m || m[1] !== key || !d?.file) continue;
    if (!names.some(x => x.startsWith(m[2]) && x.endsWith('.mp3'))) continue;
    st.redo[id] = d.file; n++;
  }
  saveState(st);
  return n;
}

const norm = t => String(t || '').replace(/\r/g, '').trim();
async function saveSettings(folder, want, io) {
  let saved = io.getText ? norm(await io.getText(folder + '/ext.ini').catch(() => '')) === norm(want) : false;
  for (let a = 1; a <= 3 && !saved; a++) {
    try { await io.putText(folder + '/ext.ini', want); } catch {
      if (io.update) { const settings = Object.fromEntries(want.trim().split('\n').map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })); await io.update(folder, settings).catch(() => {}); }
    }
    saved = io.getText ? norm(await io.getText(folder + '/ext.ini').catch(() => '')) === norm(want) : true;
    if (!saved) await new Promise(r => setTimeout(r, 1500 * a));
  }
  if (!saved) throw new Error('playback settings not saved in Yemot');
}

// One recorded hour -> one phone file in Yemot, under the folder's next number.
export async function publishHour(item, io) {
  const { ch, id, hour, files } = item;
  const folder = hourFolder(ch.key, hour);
  let f0 = (loadState().folders || {})[ch.key + '/' + hour];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tvpub-'));
  try {
    if (!f0 && !item.number) {
      // First publication into this folder: anything left from the earlier
      // on-demand layout is cleared, so the numbers mean days.
      const dir = await io.list?.(folder).catch(() => null);
      for (const f of dir?.files || []) { const n = String(f.name || ''); if (/^\d{3}\.wav$/i.test(n)) await io.del(folder + '/' + n).catch(() => {}); }
      f0 = { next: 0, days: {} };
    }
    const bin = SYSTEM_FFMPEG.find(b => existsSync(b)) || 'ffmpeg';
    const list = path.join(tmp, 'list.txt');
    await fs.writeFile(list, files.map(f => "file '" + f.replace(/'/g, "'\\''") + "'").join('\n'));
    const raw = path.join(tmp, 'hour.raw.wav');
    await new Promise((res, rej) => {
      // At most one hour (23.11: a recorder restart inside an hour gave channel 12
      // two overlapping recordings; the joined hour was too long for Yemot).
      const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-t', '3600', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', raw], { stdio: ['ignore', 'ignore', 'pipe'] });
      let e = ''; p.stderr.on('data', d => { e = (e + d).slice(-300); });
      p.on('error', rej); p.on('close', c => c === 0 ? res() : rej(new Error('joining the hour failed: ' + e.trim().slice(-160))));
    });
    const out = path.join(tmp, 'hour.wav');
    const m = await masterSpeech(raw, out);
    await fs.unlink(raw).catch(() => {});
    f0 ||= { next: 0, days: {} };
    const redo = !!item.number;
    const number = redo ? item.number : String(f0.next).padStart(3, '0');
    // Settings first: writing them creates the folder in Yemot (measured 19.11:
    // folders 5/1-5/9 were created that way), and a big file sent in parts is
    // moved into its folder at the end - which fails when the folder is missing.
    await saveSettings(folder, hourIni(ch.key, ch.title, hour), io);
    // Made again in place: the old file goes first, so the new one takes its
    // number (a big file joined in parts is moved into place at the end).
    if (redo) await io.del(folder + '/' + number + '.wav').catch(() => {});
    for (let a = 1; ; a++) {
      try { await io.upload(out, folder + '/' + number + '.wav'); break; }
      catch (e) { if (a >= 3) throw e; await new Promise(r => setTimeout(r, 5000 * a)); }
    }
    const s2 = loadState(); s2.done ||= {}; s2.folders ||= {};
    if (!redo) { f0.days[number] = id; f0.next++; s2.folders[ch.key + '/' + hour] = f0; }
    if (s2.redo) delete s2.redo[ch.key + '/' + id];
    s2.done[ch.key + '/' + id] = { file: number, minutes: Math.round((m?.durationSec || 0) / 60), at: new Date().toISOString(), ...(m?.hissCut ? { hissCut: true } : {}) };
    saveState(s2);
    note({ key: ch.key, hour: id, ok: true, file: number, minutes: Math.round((m?.durationSec || 0) / 60), ...(redo ? { redo: true } : {}), ...(m?.hissCut ? { hissCut: true } : {}) });
    io.log?.info?.('[TV REPLAY] hour published', { key: ch.key, id, file: number });
    return folder.replace(/^ivr2:/, '');
  } catch (e) {
    note({ key: ch.key, hour: id, ok: false, files: files.length, error: String(e?.message || e).slice(0, 600) });
    throw e;
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

// Runs every few minutes: publishes every finished hour, oldest first, one
// at a time. A failure stops the round; the next round tries again.
let running = false;
export const failedAt = new Map(); // hour -> { at, tries } (this server run)
export async function publishPending(channels, io, now = Date.now()) {
  if (running) return 0; running = true;
  let n = 0, failures = 0;
  try {
    for (const item of await hoursToPublish(channels)) {
      // One hour that fails (23.11: a Yemot error on channel 12's 16:00) must
      // not hold up every other channel: it waits and is tried again later
      // (5 min, then 10, 20... up to an hour); the round goes on to the next.
      const k = item.ch.key + '/' + item.id;
      const f = failedAt.get(k);
      if (f && now - f.at < Math.min(60, 5 * 2 ** (f.tries - 1)) * 60000) continue;
      try { await publishHour(item, io); n++; failedAt.delete(k); }
      catch (e) {
        failedAt.set(k, { at: now, tries: (f?.tries || 0) + 1 });
        io.log?.warn?.('[TV REPLAY] hour not published; tried again later', { key: item.ch.key, id: item.id, message: String(e?.message || e).slice(0, 160) });
        if (++failures >= 3) break; // Yemot itself in trouble: next round
      }
    }
  } finally { running = false; }
  return n;
}
