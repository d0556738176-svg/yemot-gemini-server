// Branch 2: segmented playback inside one call, plus an owner-only test source.
//
// How a call moves to the next segment (no second response to one request):
// each segment is played with call.read(..., 'tap') allowing an empty answer
// after a 1-second wait. When the segment ends, Yemot sends a NEW request to
// the server, and only then is the next segment sent. The caller may press 9
// to stop. While segment N plays, segment N+1 is prepared in the background.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { prepareSegment, SEGMENT_SECONDS } from './segmented-audio.js';
import { _pipeline } from './youtube-authorized-playback.js';

const FIRST_SEGMENT_BUDGET_MS = Number(process.env.BRANCH2_FIRST_SEGMENT_BUDGET_MS || 60000);
const NEXT_WAIT_SLICE_MS = 8000;   // longest a single Yemot request is held
const NEXT_WAIT_ROUNDS = 4;        // then "please wait" prompts, bounded

// --- Yemot adapter (GetFile semantics measured on the real account) ---------

async function getFile(remote) {
  const url = new URL(_pipeline.YEMOT_API_BASE + '/GetFile');
  url.searchParams.set('token', _pipeline.yemotApiKey());
  url.searchParams.set('what', remote);
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = await r.json().catch(() => null);
  const ready = r.ok && data?.responseStatus === 'OK' && data?.file?.exists !== false && Number(data?.file?.size) > 44;
  return { ready, durationSec: Number(data?.file?.duration) || 0 };
}
export const yemotSegmentStore = {
  isReady: getFile,
  verify: getFile,
  upload: (file, remote) => _pipeline.uploadToYemot(file, remote)
};

function raceTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise(r => { t = setTimeout(() => r(null), ms); })]).finally(() => clearTimeout(t));
}

// Tap read that returns after the file ends (empty answer) or on a key press.
// Option names are those of yemot-router2's read 'tap' mode.
const TAP_AFTER_FILE = { max_digits: 1, min_digits: 0, sec_wait: 1, allow_empty: true, empty_val: 'next', typing_playback_mode: 'No' };

/**
 * Play a source segment by segment in this call. Returns a short Hebrew
 * status line for the caller's next prompt; throws only on hang-up/exit.
 */
export async function playSegmented(call, { sourceKey, resolveSourceUrl, log = console, yemot = yemotSegmentStore }) {
  const deps = { resolveSourceUrl, yemot, log };
  const held = new Map();
  const get = i => { if (!held.has(i)) held.set(i, prepareSegment(sourceKey, i, deps)); return held.get(i); };
  const drop = i => { held.get(i)?.release(); held.delete(i); };
  const started = Date.now();
  try {
    let index = 0;
    let seg;
    try { seg = await raceTimeout(get(0).promise, FIRST_SEGMENT_BUDGET_MS); }
    catch (e) {
      log.warn('[SEGMENT] first segment failed', { sourceKey, code: e?.code || 'error', message: String(e?.message || '').slice(0, 120) });
      return 'לא הצלחתי להכין את ההשמעה.';
    }
    if (!seg) return 'הכנת הקטע הראשון לקחה יותר מדי זמן.';
    log.info('[SEGMENT] first segment ready for call', { sourceKey, msToFirstReady: Date.now() - started, cached: seg.cached, bytesFetched: seg.bytesFetched });
    for (;;) {
      if (!seg.playPath) return 'ההשמעה הסתיימה.';
      if (!seg.isLast) get(index + 1); // prefetch exactly one segment ahead
      const playStarted = Date.now();
      log.info('[SEGMENT] playing', { sourceKey, segment: index + 1, durationSec: seg.durationSec, msSinceRequest: playStarted - started });
      const key = await call.read([{ type: 'file', data: seg.playPath }], 'tap', TAP_AFTER_FILE);
      log.info('[SEGMENT] returned after segment', { sourceKey, segment: index + 1, key: String(key), heldMs: Date.now() - playStarted });
      drop(index);
      if (String(key) === '9') return 'ההשמעה הופסקה.';
      if (seg.isLast) return 'ההשמעה הסתיימה.';
      index++;
      seg = null;
      for (let round = 0; round < NEXT_WAIT_ROUNDS && !seg; round++) {
        try { seg = await raceTimeout(get(index).promise, NEXT_WAIT_SLICE_MS); }
        catch (e) {
          log.warn('[SEGMENT] next segment failed', { sourceKey, segment: index + 1, code: e?.code || 'error', message: String(e?.message || '').slice(0, 120) });
          return 'לא הצלחתי להכין את המשך ההשמעה.';
        }
        if (!seg) {
          log.warn('[SEGMENT] next segment not ready yet', { sourceKey, segment: index + 1, round: round + 1 });
          await call.read([{ type: 'text', data: 'ההמשך בהכנה. נא להמתין.' }], 'tap', TAP_AFTER_FILE);
        }
      }
      if (!seg) return 'המשך ההשמעה לא הוכן בזמן.';
    }
  } finally {
    // Hang-up and router exits propagate from call.read; preparation errors
    // were handled above. Either way, release what this call held.
    for (const i of [...held.keys()]) drop(i); // cancels work nobody else needs
  }
}

// --- owner test source --------------------------------------------------------
// 7.5 minutes, pitch steps every 10 s and a short gap every second, so a
// listener can hear continuity; fragmented MP4/AAC like YouTube's audio.
export const TEST_SOURCE_VERSION = 'tone450fragv1';
// Generated once per process; concurrent requests share the same promise and
// the file appears only after FFmpeg finished (temp file + rename).
let testSourcePromise = null;
export function ensureTestSource() {
  if (!testSourcePromise) {
    testSourcePromise = generateTestSource().catch(e => { testSourcePromise = null; throw e; });
  }
  return testSourcePromise;
}
async function generateTestSource() {
  const out = path.join(os.tmpdir(), 'branch2-' + TEST_SOURCE_VERSION + '.m4a');
  if (fsSync.existsSync(out)) return out;
  const tmp = out + '.' + process.pid + '.part.m4a';
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const c = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      "aevalsrc='0.4*sin(2*PI*(300+40*mod(floor(t/10),12))*t)*lt(mod(t,1),0.85)':s=44100:d=450",
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof+global_sidx',
      '-frag_duration', '5000000', '-f', 'mp4', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; c.stderr.on('data', d => { err += d; });
    c.on('error', reject);
    c.on('close', code => code === 0 ? resolve() : reject(new Error('test source ffmpeg ' + code + ': ' + err.slice(-200))));
  });
  await fs.rename(tmp, out);
  console.info('[SEGMENT] test source generated', { bytes: (await fs.stat(out)).size, ms: Date.now() - started });
  return out;
}

// Express handler with byte-range support for the test source.
export async function serveTestSource(req, res) {
  try {
    const file = await ensureTestSource();
    const size = (await fs.stat(file)).size;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': size, 'accept-ranges': 'bytes' });
      return fsSync.createReadStream(file).pipe(res);
    }
    const a = Number(m[1]), b = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (a >= size) { res.writeHead(416, { 'content-range': 'bytes */' + size }); return res.end(); }
    res.writeHead(206, { 'content-type': 'audio/mp4', 'content-length': b - a + 1, 'content-range': 'bytes ' + a + '-' + b + '/' + size, 'accept-ranges': 'bytes' });
    fsSync.createReadStream(file, { start: a, end: b }).pipe(res);
  } catch {
    res.status(500).end();
  }
}

export function testSourceUrl() {
  const base = String(process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  return base ? base + '/branch2-selftest/source.m4a' : null;
}

export { SEGMENT_SECONDS };
