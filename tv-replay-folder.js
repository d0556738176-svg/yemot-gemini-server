// Owner, 19.11: a recorded hour plays in a real Yemot playback folder, with
// exactly extension 7's keys (1 +10s, 3 -10s, 4/6 previous/next 10-minute
// file, 7 +3 min, 5 pause), 0 = back to choosing the hour, # = main menu.
//   folder: ivr2:/5/9/<channel>/<HH>   files 000.wav, 001.wav ... in time order
// Each 10-minute recording becomes one phone file mastered like the downloads
// (WAV 16 kHz mono 16-bit, low cut 100 Hz, gentle noise reduction, peak -2 dB).
// A file already in Yemot is not made again; a file still being recorded is
// refreshed. Folders not played for 3 hours are emptied, to keep Yemot light.
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLAY_KEYS } from './branch2-ext7.js';
import { filesForHour, targetDay, masterSpeech, REC_DIR } from './tv-recorder.js';

const STATE_FILE = path.join(REC_DIR, 'yemot-hours.json');
const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = s => { try { writeFileSync(STATE_FILE, JSON.stringify(s)); } catch {} };

export const hourFolder = (key, hour) => 'ivr2:/5/9/' + key + '/' + String(hour).padStart(2, '0');

export function hourIni(key, title, hour) {
  const keys = { ...PLAY_KEYS };
  delete keys.control_play8; delete keys.control_play9; delete keys.api_hangup_send; // file details / dubbing: not for TV
  keys.control_play0 = 'go_to_folder';
  keys.playfile_control_play_0_goto = '/5/9/' + key;
  keys['control_play#'] = 'go_to_folder';
  keys['playfile_control_play_#_goto'] = '/';
  // start=min: from the first 10 minutes of the hour onward, in time order
  // (the same setting extension 6's lessons use).
  return ['type=playfile', 'title=' + title + ' שעה ' + hour, 'start=min', ...Object.entries(keys).map(([k, v]) => k + '=' + v), 'ext5_tv=yes'].join('\n') + '\n';
}

const jobs = new Map();
export const replayLog = []; // last preparations (ok / error), for the status page
const note = x => { replayLog.unshift({ at: new Date().toISOString(), ...x }); replayLog.length = Math.min(replayLog.length, 30); };

// io: { putText(what, contents), upload(file, remote), del(remote), log }
// Returns a job { done:Promise, total, ready } shared by callers of the same hour.
export function prepareHour(ch, hour, io) {
  const id = ch.key + ':' + hour;
  if (jobs.has(id)) return jobs.get(id);
  const job = { total: 0, ready: 0, error: null };
  job.done = (async () => {
    const files = await filesForHour(ch.key, hour);
    job.total = files.length;
    if (!files.length) throw new Error('no recording');
    const folder = hourFolder(ch.key, hour);
    const day = targetDay(hour);
    const state = loadState();
    let entry = state[id];
    if (!entry || entry.day !== day) {
      // Another day's hour (or nothing yet): the folder starts empty.
      for (const n of entry?.files ? Object.keys(entry.files) : []) await io.del(folder + '/' + n + '.wav').catch(() => {});
      entry = { day, files: {} };
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tvhour-'));
    try {
      let i = 0;
      const work = files.map((src, n) => ({ src, n: String(n).padStart(3, '0') }));
      const one = async () => {
        while (i < work.length) {
          const w = work[i++];
          const st = await fs.stat(w.src).catch(() => null);
          const sig = st ? st.size + ':' + Math.round(st.mtimeMs) : null;
          if (sig && entry.files[w.n] === sig) { job.ready++; continue; } // already in Yemot, unchanged
          const out = path.join(tmp, w.n + '.wav');
          await masterSpeech(w.src, out);
          for (let a = 1; ; a++) {
            try { await io.upload(out, folder + '/' + w.n + '.wav'); break; }
            catch (e) { if (a >= 3) throw e; await new Promise(r => setTimeout(r, 2000 * a)); }
          }
          await fs.unlink(out).catch(() => {});
          entry.files[w.n] = sig;
          job.ready++;
        }
      };
      await Promise.all([one(), one()]);
    } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
    // Settings last: Yemot creates a new folder only with its first file, and
    // refuses settings for a folder that does not exist yet (19.11).
    const want = hourIni(ch.key, ch.title, hour);
    const norm = t => String(t || '').replace(/\r/g, '').trim();
    let saved = false;
    for (let a = 1; a <= 3 && !saved; a++) {
      try { await io.putText(folder + '/ext.ini', want); } catch (e) {
        if (io.update) { const settings = Object.fromEntries(want.trim().split('\n').map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })); await io.update(folder, settings).catch(() => {}); }
      }
      saved = io.getText ? norm(await io.getText(folder + '/ext.ini').catch(() => '')) === norm(want) : true;
      if (!saved) await new Promise(r => setTimeout(r, 1500 * a));
    }
    if (!saved) throw new Error('playback settings not saved in Yemot');
    entry.preparedAt = Date.now();
    const s2 = loadState(); s2[id] = entry; saveState(s2);
    io.log?.info?.('[TV REPLAY] hour ready in Yemot', { key: ch.key, hour, files: files.length });
    note({ key: ch.key, hour, ok: true, files: files.length });
    return folder.replace(/^ivr2:/, '');
  })().catch(e => { job.error = String(e?.message || e).slice(0, 160); note({ key: ch.key, hour, ok: false, error: job.error, ready: job.ready, total: job.total }); throw e; })
    .finally(() => setTimeout(() => jobs.delete(id), 5000));
  jobs.set(id, job);
  return job;
}

// Empties hour folders not played (prepared) for 3 hours.
export async function cleanupHours(io, maxAgeMs = 3 * 3600 * 1000) {
  const state = loadState(); let removed = 0;
  for (const [id, entry] of Object.entries(state)) {
    if (Date.now() - (entry.preparedAt || 0) < maxAgeMs || jobs.has(id)) continue;
    const [key, hour] = id.split(':');
    for (const n of Object.keys(entry.files || {})) { await io.del(hourFolder(key, hour) + '/' + n + '.wav').catch(() => {}); removed++; }
    delete state[id];
  }
  saveState(state);
  if (removed) io.log?.info?.('[TV REPLAY] old hours removed from Yemot', { files: removed });
}
