// Extension 6: learning menu. 1 = English reading course, 2 = programming course.
// On start the main service builds every lesson that is missing or changed (speech from free
// Edge neural voices + an original background music bed, ducked under the speech), uploads it
// to ivr2:/6/<course>/000.wav ..., and keeps progress in Yemot so a restart resumes.
import { readFileSync, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { synthesize } from './edge-tts.js';

const API = 'https://www.call2all.co.il/ym/api';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HE_VOICE = process.env.ENGLISH_HE_VOICE || 'he-IL-AvriNeural';
const EN_VOICE = process.env.ENGLISH_EN_VOICE || 'en-US-AndrewNeural';
const BUILD_VERSION = 'v2-music';
const log = (...a) => console.info('[COURSES]', ...a);

export const COURSES = [
  { id: 'english', folder: 'ivr2:/6/1', json: 'course-english.json', music: 'music-english.mp3', title: 'לימוד אנגלית' },
  { id: 'code', folder: 'ivr2:/6/2', json: 'course-code.json', music: 'music-code.mp3', title: 'לימוד תכנות' },
];

// Same keys as extension 7: * = Yemot's star menu (playlist settings), 0 = main menu (owner, 12.11).
const playIni = title => ['type=playfile', 'title=' + title, 'start=min', 'control_play6=plus', 'control_play4=minus',
  'control_play5=wait', 'control_play1=seconds_plus', 'control_play3=seconds_minus', 'control_play7=minut_plus_amount1',
  'minut_plus_amount1=180000', 'control_play0=go_to_folder', 'playfile_control_play_0_goto=/',
  'save_last_play=yes', 'last_play_auto=yes', ''].join('\n');
const MENU_INI = ['type=menu', 'title=לימוד', ''].join('\n');
const MENU_SEGMENTS = [['jingle'], ['he', 'ברוך הבא לשלוחת הלימוד!'], ['p', 0.5],
  ['he', 'ללימוד אנגלית וקריאה באנגלית, הקש אחת.'], ['p', 0.4], ['he', 'ללימוד תכנות, מאפס ועד מתכנת של ממש, הקש שתיים.'], ['p', 0.4],
  ['he', 'בכל שלוחה, השיעורים ממשיכים מהמקום שבו עצרת. בתוך השיעורים, לחזרה לתפריט הראשי הקש אפס.'], ['p', 2]];

function token() {
  const t = String(process.env.YEMOT_TOKEN || '').trim();
  if (t) return t;
  const u = String(process.env.YEMOT_API_USERNAME || '').trim(), p = String(process.env.YEMOT_API_PASSWORD || '').trim();
  return u && p ? u + ':' + p : '';
}

async function api(name, params, method = 'GET') {
  const body = new URLSearchParams({ token: token(), ...params });
  const r = method === 'GET'
    ? await fetch(API + '/' + name + '?' + body, { signal: AbortSignal.timeout(30000) })
    : await fetch(API + '/' + name, { method, body, signal: AbortSignal.timeout(30000) });
  return r.json().catch(() => null);
}
const getText = async what => { const j = await api('GetTextFile', { what }); return j?.responseStatus === 'OK' ? String(j.contents ?? '') : null; };
async function putText(what, contents) {
  const j = await api('UploadTextFile', { what, contents }, 'POST');
  if (j?.responseStatus !== 'OK') throw new Error('UploadTextFile ' + what + ': ' + (j?.message || 'failed'));
}
async function ensureIni(what, want) {
  const cur = await getText(what);
  if (String(cur || '').replace(/\r/g, '').trim() === want.trim()) return;
  log('setting', what, '(was', JSON.stringify(String(cur || '').slice(0, 200)) + ')');
  await putText(what, want);
}

async function ensureIniVerified(what, want) {
  await ensureIni(what, want);
  const now = await getText(what);
  const ok = String(now || '').replace(/\r/g, '').trim() === want.trim();
  log(what, ok ? 'settings verified' : 'settings NOT kept: ' + JSON.stringify(String(now || '').slice(0, 120)));
  return ok;
}

async function uploadAudio(buffer, remotePath, filename, type) {
  const u = new URL(API + '/UploadFile');
  u.searchParams.set('token', token()); u.searchParams.set('path', remotePath);
  u.searchParams.set('convertAudio', '1'); u.searchParams.set('autoNumbering', 'false');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  const r = await fetch(u, { method: 'POST', body: form, signal: AbortSignal.timeout(240000) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok || !j || (j.responseStatus && j.responseStatus !== 'OK') || j.success === false)
    throw new Error('UploadFile ' + remotePath + ': HTTP ' + r.status + ' ' + text.slice(0, 200));
  return j;
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; c.stderr.on('data', d => { err += d; });
    c.on('error', reject);
    c.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg ' + code + ': ' + err.slice(-300))));
  });
}

const rateStr = r => (r >= 0 ? '+' : '') + Math.round(r) + '%';
// One fixed voice per language; transient failures are retried, never answered by switching voice.
async function speak(seg) {
  const isHe = seg[0] === 'he';
  let last;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return await synthesize(seg[1], { voice: isHe ? HE_VOICE : EN_VOICE, rate: isHe ? '-4%' : rateStr(seg[2] ?? -10), timeoutMs: 25000 }); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 20000))); }
  }
  throw last;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// segments -> one 8 kHz mono wav: speech (+ jingles) on top of a looped, ducked music bed.
export async function buildAudio(segments, dir, musicFile, speakFn = speak) {
  const silences = new Map();
  const silence = async sec => {
    const key = Number(sec).toFixed(1);
    if (!silences.has(key)) {
      const f = path.join(dir, 'sil-' + key + '.mp3');
      await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', key, '-c:a', 'libmp3lame', '-b:a', '48k', f]);
      silences.set(key, f);
    }
    return silences.get(key);
  };
  const jingle = path.join(dir, 'jingle.mp3');
  await ffmpeg(['-i', path.join(HERE, 'jingle.mp3'), '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '48k', jingle]);
  const cache = new Map();
  const files = await mapLimit(segments, 10, async (seg, k) => {
    if (seg[0] !== 'he' && seg[0] !== 'en') return null;
    const key = seg.join('|');
    if (!cache.has(key)) cache.set(key, (async () => { const f = path.join(dir, 's' + k + '.mp3'); await fs.writeFile(f, await speakFn(seg)); return f; })());
    return cache.get(key);
  });
  const list = [];
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k];
    if (seg[0] === 'p') list.push(await silence(seg[1]));
    else if (seg[0] === 'jingle') list.push(jingle);
    else list.push(files[k]);
    list.push(await silence(0.25));
  }
  const listFile = path.join(dir, 'list.txt');
  await fs.writeFile(listFile, list.map(f => "file '" + f + "'").join('\n'));
  const voice = path.join(dir, 'voice.wav');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-ar', '24000', '-ac', '1', voice]);
  const out = path.join(dir, 'lesson.wav');
  const music = path.join(HERE, musicFile);
  await ffmpeg(['-i', voice, '-stream_loop', '-1', '-i', music, '-filter_complex',
    '[0:a]asplit=2[sp][sc];[1:a]aresample=24000,aformat=channel_layouts=mono,volume=0.075[mu];' +
    '[mu][sc]sidechaincompress=threshold=0.01:ratio=12:attack=8:release=600[duck];' +
    '[sp][duck]amix=inputs=2:duration=first:normalize=0,highpass=f=110,loudnorm=I=-17:TP=-2:LRA=9[out]',
    '-map', '[out]', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  return out;
}

export async function wavToMp3(wav, dir) {
  const mp3 = path.join(dir, 'upload.mp3');
  await ffmpeg(['-i', wav, '-c:a', 'libmp3lame', '-b:a', '32k', mp3]);
  return fs.readFile(mp3);
}
async function uploadWav(wav, remote, dir) {
  return uploadMp3(await wavToMp3(wav, dir), remote);
}
const uploadMp3 = (buf, remote) => uploadAudio(buf, remote, path.basename(remote).replace(/\.wav$/, '.mp3'), 'audio/mpeg');
export function loadCourse(c) {
  return JSON.parse(readFileSync(path.join(HERE, c.json), 'utf8'));
}

// Lessons are built on a separate service (course builder) that other work never redeploys,
// because this main service is redeployed often and a restart threw away a lesson mid-build.
// Here we only fetch the finished mp3 (seconds) and upload it. If the builder cannot be
// reached at all, the lesson is built here as before.
const BUILDER = (process.env.COURSE_BUILDER_URL || 'https://yemot-course-builder.onrender.com').replace(/\/$/, '');
async function fetchFromBuilder(c, lesson) {
  const want = hashOf(lesson.segments, c.music);
  const deadline = Date.now() + 25 * 60 * 1000;
  let failures = 0;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BUILDER + '/lesson?course=' + c.id + '&n=' + lesson.n, { signal: AbortSignal.timeout(90000) });
      if (r.status === 200 && r.headers.get('x-lesson-hash') === want) return Buffer.from(await r.arrayBuffer());
      if (r.status === 200) throw new Error('builder has a different version of the lesson');
      const j = await r.json().catch(() => ({}));
      if (j.state === 'failed') throw new Error('builder failed: ' + String(j.error || '').slice(0, 160));
      failures = 0;
    } catch (e) {
      if (++failures >= 6) throw e;
    }
    await new Promise(r => setTimeout(r, 20000));
  }
  throw new Error('builder timeout');
}

export const hashOf = (segments, music) => createHash('sha1').update(BUILD_VERSION + HE_VOICE + EN_VOICE + music + JSON.stringify(segments)).digest('hex').slice(0, 16);

export async function withTemp(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// The first English course (v1) lived directly in /6; once /6 is a menu those files are removed.
async function removeOldCourse() {
  const old = await getText('ivr2:/6/english-course-progress.txt');
  if (!old) return;
  let files = [];
  try { files = Object.values(JSON.parse(old).lessons || {}).map(x => x.file).filter(f => /^ivr2:\/6\/\d{3}\.wav$/.test(f)); } catch {}
  const params = { action: 'delete' };
  [...files, 'ivr2:/6/english-course-progress.txt'].forEach((f, i) => { params['what' + i] = f; });
  const j = await api('FileAction', params, 'POST');
  log('removed the old single course from /6:', files.length, 'files', j?.responseStatus || j?.message || 'no answer');
}

let running = false;
export async function runCoursesJob() {
  if (running) return;
  if (String(process.env.ENGLISH_LESSONS || 'on') === 'off') return log('disabled by ENGLISH_LESSONS=off');
  if (process.env.RENDER_SERVICE_NAME && process.env.RENDER_SERVICE_NAME !== 'yemot-gemini-server' && process.env.ENGLISH_LESSONS !== 'force')
    return log('not the main service; skipping');
  if (!token()) return log('no Yemot credentials; skipping');
  running = true;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const keepAlive = base ? setInterval(() => fetch(base + '/').catch(() => {}), 4 * 60 * 1000) : null;
  try {
    // The menu first, so callers get it right away.
    const menuProgress = await getText('ivr2:/6/courses-menu.txt');
    const menuHash = hashOf(MENU_SEGMENTS, 'music-english.mp3');
    if (menuProgress?.trim() !== menuHash) {
      await withTemp('menu-', async dir => {
        const wav = await buildAudio(MENU_SEGMENTS, dir, 'music-english.mp3');
        await uploadWav(wav, 'ivr2:/6/M1000.wav', dir);
      });
      await putText('ivr2:/6/courses-menu.txt', menuHash);
      log('learning menu message uploaded');
    }
    await ensureIni('ivr2:/6/ext.ini', MENU_INI);
    for (const c of COURSES) await ensureIni(c.folder + '/ext.ini', playIni(c.title));
    await removeOldCourse().catch(e => log('old course cleanup failed', String(e.message).slice(0, 200)));

    // Both courses are built side by side (one lesson of each in turn), so each extension has
    // lessons to play right away instead of one waiting hours for the other to finish.
    const state = [];
    for (const c of COURSES) {
      const course = loadCourse(c);
      const progressPath = c.folder + '/course-progress.txt';
      let progress = {};
      try { progress = JSON.parse((await getText(progressPath)) || '{}'); } catch {}
      progress.lessons ||= {};
      const todo = course.lessons.filter(l => progress.lessons[l.n]?.hash !== hashOf(l.segments, c.music));
      log(c.id + ':', course.lessons.length, 'lessons;', todo.length, 'to build');
      state.push({ c, course, progress, progressPath, todo });
    }
    while (state.some(s => s.todo.length)) {
      for (const s of state) {
        const lesson = s.todo.shift();
        if (!lesson) continue;
        const { c, progress, progressPath } = s;
        const t0 = Date.now();
        try {
          const remote = c.folder + '/' + String(lesson.n - 1).padStart(3, '0') + '.wav';
          let seconds;
          try {
            const mp3 = await fetchFromBuilder(c, lesson);
            await uploadMp3(mp3, remote);
            seconds = Math.round(mp3.length / 4000);
          } catch (e) {
            log(c.id, 'lesson', lesson.n, 'builder unavailable, building here:', String(e?.message || e).slice(0, 160));
            seconds = await withTemp(c.id + '-' + lesson.n + '-', async dir => {
              const wav = await buildAudio(lesson.segments, dir, c.music);
              const size = (await fs.stat(wav)).size;
              await uploadWav(wav, remote, dir);
              return Math.round(size / 16000);
            });
          }
          progress.lessons[lesson.n] = { hash: hashOf(lesson.segments, c.music), file: remote, seconds, at: new Date().toISOString() };
          await putText(progressPath, JSON.stringify(progress));
          log(c.id, 'lesson', lesson.n, 'uploaded', { remote, seconds, buildSec: Math.round((Date.now() - t0) / 1000) });
          // A Yemot folder only exists once it holds a file, so its settings are (re)written and
          // verified after an upload; before that, an ext.ini written there is not kept.
          if (!s.iniOk) s.iniOk = await ensureIniVerified(c.folder + '/ext.ini', playIni(c.title));
        } catch (e) {
          log(c.id, 'lesson', lesson.n, 'FAILED', String(e?.message || e).slice(0, 300));
        }
      }
    }
    for (const { c, course, progress } of state) {
      const done = course.lessons.filter(l => progress.lessons[l.n]?.hash === hashOf(l.segments, c.music)).length;
      log(c.id + ' finished:', done, 'of', course.lessons.length, 'lessons are in', c.folder);
    }
  } catch (e) {
    log('job crashed', String(e?.message || e).slice(0, 300));
  } finally {
    if (keepAlive) clearInterval(keepAlive);
    running = false;
  }
}
