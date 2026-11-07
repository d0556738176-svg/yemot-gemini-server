// Extension 6: a spoken English course (38 lessons, Hebrew teacher voice + English voice).
// On start, the main service builds any lesson that is missing or changed and uploads it
// to ivr2:/6 as 000.wav, 001.wav ... (lesson 1 = 000), then sets /6 to play the files in order.
// Progress is kept in Yemot (ivr2:/6/english-course-progress.txt), so a restart resumes.
import { readFileSync, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { synthesize } from './edge-tts.js';

const API = 'https://www.call2all.co.il/ym/api';
const FOLDER = 'ivr2:/6';
const PROGRESS = FOLDER + '/english-course-progress.txt';
const HE_VOICE = process.env.ENGLISH_HE_VOICE || 'he-IL-AvriNeural';
const EN_VOICES = [process.env.ENGLISH_EN_VOICE || 'en-US-AndrewNeural'];
const BUILD_VERSION = 'v1';
const log = (...a) => console.info('[ENGLISH]', ...a);

function token() {
  const t = String(process.env.YEMOT_TOKEN || '').trim();
  if (t) return t;
  const u = String(process.env.YEMOT_API_USERNAME || '').trim(), p = String(process.env.YEMOT_API_PASSWORD || '').trim();
  return u && p ? u + ':' + p : '';
}

async function getText(what) {
  const r = await fetch(API + '/GetTextFile?' + new URLSearchParams({ token: token(), what }), { signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  return j?.responseStatus === 'OK' ? String(j.contents ?? '') : null;
}

async function putText(what, contents) {
  const r = await fetch(API + '/UploadTextFile', { method: 'POST', body: new URLSearchParams({ token: token(), what, contents }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (j?.responseStatus !== 'OK') throw new Error('UploadTextFile ' + what + ': ' + (j?.message || r.status));
}

async function uploadAudio(buffer, remotePath, filename, type) {
  const u = new URL(API + '/UploadFile');
  u.searchParams.set('token', token()); u.searchParams.set('path', remotePath);
  u.searchParams.set('convertAudio', '1'); u.searchParams.set('autoNumbering', 'false');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  const r = await fetch(u, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) });
  const body = await r.text();
  let j = null; try { j = JSON.parse(body); } catch {}
  if (!r.ok || !j || (j.responseStatus && j.responseStatus !== 'OK') || j.success === false)
    throw new Error('UploadFile ' + remotePath + ': HTTP ' + r.status + ' ' + body.slice(0, 200));
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

// One fixed voice per language for the whole course; transient timeouts are retried, never
// answered by switching voice (a mixed voice inside a lesson sounds broken).
async function speak(seg) {
  const isHe = seg[0] === 'he';
  const voice = isHe ? HE_VOICE : EN_VOICES[0];
  const rate = isHe ? '-4%' : rateStr(seg[2] ?? -10);
  let last;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return await synthesize(seg[1], { voice, rate, timeoutMs: 25000 }); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 20000))); }
  }
  throw last;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

export async function buildLesson(lesson, dir, speakFn = speak) {
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
  const cache = new Map();
  const speechFiles = await mapLimit(lesson.segments, 6, async (seg, k) => {
    if (seg[0] === 'p') return null;
    const key = seg.join('|');
    if (!cache.has(key)) cache.set(key, (async () => { const f = path.join(dir, 's' + k + '.mp3'); await fs.writeFile(f, await speakFn(seg)); return f; })());
    return cache.get(key);
  });
  const list = [];
  for (let k = 0; k < lesson.segments.length; k++) {
    const seg = lesson.segments[k];
    list.push(seg[0] === 'p' ? await silence(seg[1]) : speechFiles[k], await silence(0.25));
  }
  const listFile = path.join(dir, 'list.txt');
  await fs.writeFile(listFile, list.map(f => "file '" + f + "'").join('\n'));
  const out = path.join(dir, 'lesson.wav');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-af', 'highpass=f=120,loudnorm=I=-17:TP=-2:LRA=9', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  return out;
}

let running = false;
export async function runEnglishCourseJob({ force = false } = {}) {
  if (running) return;
  if (String(process.env.ENGLISH_LESSONS || 'on') === 'off') return log('disabled by ENGLISH_LESSONS=off');
  if (!force && process.env.RENDER_SERVICE_NAME && process.env.RENDER_SERVICE_NAME !== 'yemot-gemini-server' && process.env.ENGLISH_LESSONS !== 'force')
    return log('not the main service; skipping');
  if (!token()) return log('no Yemot credentials; skipping');
  running = true;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const keepAlive = base ? setInterval(() => fetch(base + '/').catch(() => {}), 4 * 60 * 1000) : null;
  try {
    const course = JSON.parse(readFileSync(new URL('./english-lessons.json', import.meta.url), 'utf8'));
    let progress = {};
    try { progress = JSON.parse((await getText(PROGRESS)) || '{}'); } catch { progress = {}; }
    progress.lessons ||= {};

    // Same keys as extension 7: 6 next lesson, 4 previous lesson, 5 pause, 1 +10s, 3 -10s,
    // 7 +3 minutes, * main menu. Starts at lesson 1 (start=min) and resumes automatically
    // where the caller last stopped (save_last_play + last_play_auto).
    const wantIni = ['type=playfile', 'title=לימוד אנגלית', 'start=min', 'control_play6=plus', 'control_play4=minus',
      'control_play5=wait', 'control_play1=seconds_plus', 'control_play3=seconds_minus', 'control_play7=minut_plus_amount1',
      'minut_plus_amount1=180000', 'control_play*=go_to_folder', 'playfile_control_play_*_goto=/',
      'save_last_play=yes', 'last_play_auto=yes', ''].join('\n');
    const ini = await getText(FOLDER + '/ext.ini');
    if (String(ini || '').replace(/\r/g, '').trim() !== wantIni.trim()) {
      log('updating extension 6 settings; previous ext.ini:', JSON.stringify(String(ini || '').slice(0, 300)));
      await putText(FOLDER + '/ext.ini', wantIni);
      log('extension 6 ext.ini now:', JSON.stringify(((await getText(FOLDER + '/ext.ini')) || '').slice(0, 400)));
    }

    const todo = course.lessons.filter(l => progress.lessons[l.n]?.hash !== hashOf(l));
    log('course has', course.lessons.length, 'lessons;', todo.length, 'to build', todo.map(l => l.n).join(','));
    for (const lesson of todo) {
      const t0 = Date.now();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'english-' + lesson.n + '-'));
      try {
        const wav = await buildLesson(lesson, dir);
        const buf = await fs.readFile(wav);
        const remote = FOLDER + '/' + String(lesson.n - 1).padStart(3, '0') + '.wav';
        let res;
        try { res = await uploadAudio(buf, remote, path.basename(remote), 'audio/wav'); }
        catch (e) {
          log('wav upload failed, retrying as mp3', String(e.message).slice(0, 200));
          const mp3 = path.join(dir, 'lesson.mp3');
          await ffmpeg(['-i', wav, '-c:a', 'libmp3lame', '-b:a', '32k', mp3]);
          res = await uploadAudio(await fs.readFile(mp3), remote, path.basename(remote).replace('.wav', '.mp3'), 'audio/mpeg');
        }
        progress.lessons[lesson.n] = { hash: hashOf(lesson), file: remote, seconds: Math.round(buf.length / 16000), at: new Date().toISOString() };
        progress.version = BUILD_VERSION;
        await putText(PROGRESS, JSON.stringify(progress));
        log('lesson', lesson.n, 'uploaded', { remote, seconds: Math.round(buf.length / 16000), buildSec: Math.round((Date.now() - t0) / 1000), yemot: res?.duration || res?.convertedSize || null });
      } catch (e) {
        log('lesson', lesson.n, 'FAILED', String(e?.message || e).slice(0, 300));
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    const done = course.lessons.filter(l => progress.lessons[l.n]?.hash === hashOf(l)).length;
    log('finished:', done, 'of', course.lessons.length, 'lessons are in extension 6');
  } catch (e) {
    log('job crashed', String(e?.message || e).slice(0, 300));
  } finally {
    if (keepAlive) clearInterval(keepAlive);
    running = false;
  }
}

function hashOf(lesson) {
  return createHash('sha1').update(BUILD_VERSION + HE_VOICE + EN_VOICES.join() + JSON.stringify(lesson.segments)).digest('hex').slice(0, 16);
}
