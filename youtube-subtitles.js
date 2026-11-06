// Hebrew subtitles for saved videos.
// The video's own sound is transcribed with timed words (Deepgram, language
// detected automatically). Speech in Hebrew needs nothing. Any other language
// is cut into short readable cues, translated to Hebrew (Gemini first, Groq as
// a fallback, in numbered batches so timing never drifts), and returned as
// SRT text to embed as a default Hebrew subtitle track. Never throws: on any
// failure the video is saved without subtitles.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { groqChat } from './groq-chat.js';

function ffmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = ''; p.stderr.on('data', d => { e = (e + d).slice(-400); });
    p.on('error', reject);
    p.on('close', c => (c === 0 ? resolve() : reject(new Error('ffmpeg ' + c + ': ' + e.trim()))));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return p(h) + ':' + p(m) + ':' + p(s) + ',' + p(r, 3);
}

// Words -> short readable cues (max ~6.5 s / 14 words, break on sentence end or pause).
export function buildCues(words) {
  const cues = []; let cur = null;
  for (const w of words || []) {
    const text = String(w.punctuated_word || w.word || '').trim();
    if (!text) continue;
    if (cur && (w.start - cur.end > 1.0 || w.end - cur.start > 6.5 || cur.n >= 14 || (/[.?!]$/.test(cur.text) && cur.n >= 3))) { cues.push(cur); cur = null; }
    if (!cur) cur = { start: w.start, end: w.end, text, n: 1 };
    else { cur.end = w.end; cur.text += ' ' + text; cur.n++; }
  }
  if (cur) cues.push(cur);
  // Keep each cue on screen at least 1.2 s when the next one allows it.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]?.start ?? Infinity;
    cues[i].end = Math.min(Math.max(cues[i].end, cues[i].start + 1.2), next - 0.05, cues[i].end + 2);
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.5;
  }
  return cues.map(({ start, end, text }) => ({ start, end, text }));
}

export function toSrt(cues) {
  return cues.map((c, i) => (i + 1) + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text + '\n').join('\n');
}

// Several setups are tried (language detection is unreliable on some models
// and short clips); the one that heard the most words wins.
export const DEEPGRAM_SETUPS = [
  { model: 'nova-2', detect_language: 'true' },
  { model: 'nova-3', language: 'multi' },
  { model: 'nova-3', detect_language: 'true' },
];
export async function transcribeTimed(audioFile, { env = process.env, fetchImpl = fetch, log = console, mime = 'audio/ogg', setups = DEEPGRAM_SETUPS, all = false } = {}) {
  const key = String(env.DEEPGRAM_API_KEY || '').trim();
  if (!key) return null;
  const body = await fs.readFile(audioFile);
  let best = null; const tried = [];
  for (const setup of setups) {
    const url = new URL('https://api.deepgram.com/v1/listen');
    for (const [k, v] of Object.entries(setup)) url.searchParams.set(k, v);
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('punctuate', 'true');
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { Authorization: 'Token ' + key, 'Content-Type': mime }, body, signal: AbortSignal.timeout(20 * 60 * 1000) });
      const j = await r.json().catch(() => null);
      const ch = j?.results?.channels?.[0];
      const words = ch?.alternatives?.[0]?.words || [];
      const language = String(ch?.detected_language || ch?.alternatives?.[0]?.languages?.[0] || words.find(w => w.language)?.language || '');
      log.info?.('[SUBTITLES] transcription attempt', { ...setup, status: r.status, bytes: body.length, language, words: words.length, error: r.ok ? undefined : String(j?.err_msg || j?.message || '').slice(0, 120) });
      const conf = words.length ? words.reduce((a, w) => a + Number(w.confidence || 0), 0) / words.length : 0;
      const res = { language, words, conf, setup, model: setup.model + (setup.language ? '/' + setup.language : '') };
      if (r.ok) tried.push(res);
      if (r.ok && (!best || words.length > best.words.length)) best = res;
      if (!all && best && best.words.length >= 20 && best.language) break;
    } catch (e) { log.warn?.('[SUBTITLES] transcription attempt failed', { ...setup, message: String(e?.message || e).slice(0, 120) }); }
  }
  return all ? { best, tried } : best;
}

function parseLines(text, n) {
  const s = String(text || '').replace(/^```(?:json)?|```$/gm, '').trim();
  try {
    const a = JSON.parse(s.slice(s.indexOf('['), s.lastIndexOf(']') + 1));
    if (Array.isArray(a) && a.length === n) return a.map(x => String(typeof x === 'object' && x ? (x.he ?? x.t ?? '') : x).trim());
  } catch { /* numbered lines below */ }
  const out = new Array(n).fill(null);
  for (const line of s.split('\n')) { const m = line.match(/^\s*(\d+)\s*[).:\-|]\s*(.+)$/); if (m && +m[1] >= 1 && +m[1] <= n) out[+m[1] - 1] = m[2].trim(); }
  return out.every(x => x) ? out : null;
}

const SYSTEM = 'אתה מתרגם כתוביות לעברית. תקבל מערך JSON של שורות כתוביות ממוספרות מסרטון. תרגם כל שורה לעברית טבעית, קצרה וברורה, בשפה נקייה ומכובדת, בהתאם להקשר של השורות הסמוכות. שמות אנשים ומקומות כתוב בעברית. החזר רק מערך JSON של מחרוזות באותו אורך ובאותו סדר בדיוק, בלי הסברים.';

async function geminiTranslate(lines, env, fetchImpl, system = SYSTEM) {
  const keys = String(env.GEMINI_API_KEYS || env.GEMINI_API_KEY || '').split(',').map(x => x.trim()).filter(Boolean);
  const models = String(env.SUBTITLE_GEMINI_MODELS || env.GEMINI_MODELS || 'gemini-3.6-flash,gemini-3.5-flash-lite').split(',').map(x => x.trim()).filter(Boolean);
  for (const model of models) for (const key of keys) {
    try {
      const r = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: JSON.stringify(lines) }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }),
      });
      if (r.status === 404) break; // model gone: next model
      const j = await r.json().catch(() => null);
      const out = parseLines(j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join(''), lines.length);
      if (out) return out;
    } catch { /* next key */ }
  }
  return null;
}

export async function translateCues(cues, { env = process.env, fetchImpl = fetch, log = console, batch = 60 } = {}) {
  const out = [];
  let ok = 0;
  for (let i = 0; i < cues.length; i += batch) {
    const part = cues.slice(i, i + batch).map(c => c.text);
    let he = await geminiTranslate(part, env, fetchImpl);
    for (let tryN = 0; !he && tryN < 3; tryN++) {
      he = parseLines(await groqChat([{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(part) }], { env, fetchImpl, maxTokens: 4000, timeoutMs: 60000 }), part.length);
      if (!he) await sleep(8000 * (tryN + 1)); // rate limit pacing
    }
    if (he) ok += part.length;
    else log.warn?.('[SUBTITLES] a batch stayed untranslated', { from: i, count: part.length });
    part.forEach((t, k) => out.push({ ...cues[i + k], text: (he?.[k] || t).replace(/\s+/g, ' ').trim() }));
  }
  return { cues: out, translated: ok };
}

const CORRECT = 'אתה מגיה כתוביות בעברית. תקבל מערך JSON של שורות כתוביות שנוצרו מזיהוי דיבור אוטומטי של סרטון בעברית (שיר, הרצאה או דיבור). תקן שגיאות זיהוי וכתיב לפי ההקשר, הוסף פיסוק קל, בשפה נקייה. אל תוסיף ואל תשמיט תוכן, ואל תאחד או תפצל שורות. החזר רק מערך JSON של מחרוזות באותו אורך ובאותו סדר בדיוק.';

export async function correctHebrewCues(cues, { env = process.env, fetchImpl = fetch, log = console, batch = 60 } = {}) {
  const out = [];
  for (let i = 0; i < cues.length; i += batch) {
    const part = cues.slice(i, i + batch).map(c => c.text);
    let fixed = await geminiTranslate(part, env, fetchImpl, CORRECT);
    if (!fixed) fixed = parseLines(await groqChat([{ role: 'system', content: CORRECT }, { role: 'user', content: JSON.stringify(part) }], { env, fetchImpl, maxTokens: 4000, timeoutMs: 60000 }), part.length);
    part.forEach((t, k) => out.push({ ...cues[i + k], text: String(fixed?.[k] || t).replace(/\s+/g, ' ').trim() || t }));
  }
  return out;
}

async function mediaSeconds(ffmpegPath, file) {
  const info = await new Promise(res => { const c = spawn(ffmpegPath, ['-hide_banner', '-i', file]); let e = ''; c.stderr.on('data', d => { e += d; }); c.on('close', () => res(e)); c.on('error', () => res('')); });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
}

// Hebrew subtitles already burned into the picture? A few frames are shown to
// Gemini. Unknown (no key / no answer) counts as "no".
export async function hasBurnedHebrewSubtitles(videoFile, tempDir, { ffmpegPath, env = process.env, fetchImpl = fetch, seconds, onSeen }) {
  const keys = String(env.GEMINI_API_KEYS || env.GEMINI_API_KEY || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!keys.length || !seconds) return null;
  const parts = [];
  for (const f of [0.2, 0.4, 0.6, 0.8]) {
    const out = path.join(tempDir, 'frame_' + f + '.jpg');
    try { await ffmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.floor(seconds * f)), '-i', videoFile, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out]); parts.push({ inline_data: { mime_type: 'image/jpeg', data: (await fs.readFile(out)).toString('base64') } }); } catch { /* skip frame */ }
  }
  if (!parts.length) return null;
  parts.push({ text: 'אלה ' + parts.length + ' תמונות מתוך סרטון, לפי הסדר. לכל תמונה, העתק את שורת הכתובית בעברית שצרובה בתמונה (טקסט של דיבור או תרגום, בדרך כלל בתחתית המסך). כותרת קבועה, שם השיר, שם הערוץ, לוגו או כיתוב פרסומי אינם כתובית: במקרה כזה החזר מחרוזת ריקה. החזר JSON בלבד: {"frames": ["...", "..."]}' });
  const models = String(env.SUBTITLE_GEMINI_MODELS || env.GEMINI_MODELS || 'gemini-3.6-flash,gemini-3.5-flash-lite').split(',').map(x => x.trim()).filter(Boolean);
  for (const model of models) for (const key of keys) {
    try {
      const r = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(45000),
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
      });
      if (r.status === 404) break;
      const j = await r.json().catch(() => null);
      const t = j?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '';
      let frames = null;
      try { frames = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)).frames; } catch { /* next */ }
      if (Array.isArray(frames)) {
        const lines = frames.map(x => String(x || '').trim()).filter(x => /[א-ת]{2,}/.test(x));
        const distinct = new Set(lines).size;
        onSeen?.(lines);
        return distinct >= 2; // changing Hebrew lines in at least 2 frames
      }
    } catch { /* next key */ }
  }
  return null;
}

// The whole thing for one local video file. Returns { srt, language, cues } or
// { skipped } / null. Every video without Hebrew subtitles gets them: Hebrew
// speech is written down (and proofread), any other language is translated.
export async function hebrewSubtitlesFor(videoFile, tempDir, { ffmpegPath, env = process.env, fetchImpl = fetch, log = console, force = false } = {}) {
  try {
    if (/^(0|false|off)$/i.test(String(env.VIDEO_HEBREW_SUBTITLES || ''))) return { skipped: 'disabled' };
    const seconds = await mediaSeconds(ffmpegPath, videoFile);
    let seen = [];
    const burned = force ? null : await hasBurnedHebrewSubtitles(videoFile, tempDir, { ffmpegPath, env, fetchImpl, seconds, onSeen: l => { seen = l; } }).catch(() => null);
    log.info?.('[SUBTITLES] Hebrew subtitles in the picture?', { burned, seen: seen.map(x => x.slice(0, 60)) });
    if (burned === true) { log.info?.('[SUBTITLES] the picture already has Hebrew subtitles; none added'); return { skipped: 'hebrew_in_picture', seen }; }
    const extract = async (name, extra) => {
      let file = path.join(tempDir, name + '.ogg'), mime = 'audio/ogg';
      try { await ffmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...extra, '-i', videoFile, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', file]); }
      catch { file = path.join(tempDir, name + '.mp3'); mime = 'audio/mpeg'; await ffmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...extra, '-i', videoFile, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', file]); }
      return { file, mime };
    };
    const t0 = Date.now();
    // 1. Which language? A sample of up to 3 minutes, every setup plus Hebrew.
    const sampleStart = seconds > 300 ? Math.floor(seconds * 0.15) : 0;
    const sample = await extract('sample', ['-ss', String(sampleStart), '-t', '180']);
    const probe = await transcribeTimed(sample.file, { env, fetchImpl, log, mime: sample.mime, all: true, setups: [...DEEPGRAM_SETUPS, { model: 'nova-3', language: 'he' }] });
    await fs.rm(sample.file, { force: true }).catch(() => {});
    if (!probe?.tried?.length) return null;
    const he = probe.tried.find(x => x.setup.language === 'he');
    const detect = probe.tried.filter(x => x !== he).sort((a, b) => b.words.length - a.words.length)[0];
    const saysHebrew = probe.tried.some(x => x !== he && /^(he|iw)/i.test(x.language));
    const hebrew = saysHebrew || (he && he.words.length >= 5 && (!detect || detect.words.length < 5 || he.conf >= detect.conf - 0.03));
    const language = hebrew ? 'he' : String(detect?.language || '').toLowerCase();
    log.info?.('[SUBTITLES] language', { language, hebrewConf: he?.conf?.toFixed?.(2), otherConf: detect?.conf?.toFixed?.(2), other: detect?.language, sampleWords: (hebrew ? he : detect)?.words?.length || 0 });
    // 2. The whole video with the right setting.
    const full = await extract('speech', []);
    const setup = hebrew ? { model: 'nova-3', language: 'he' } : (language ? { model: detect.setup.model, language } : detect.setup);
    let tr = await transcribeTimed(full.file, { env, fetchImpl, log, mime: full.mime, setups: [setup] });
    if (!tr?.words?.length && !hebrew) tr = await transcribeTimed(full.file, { env, fetchImpl, log, mime: full.mime });
    await fs.rm(full.file, { force: true }).catch(() => {});
    if (!tr || tr.words.length < 5) { log.info?.('[SUBTITLES] almost no speech; no subtitles', { language, words: tr?.words?.length || 0 }); return { skipped: 'no_speech', language }; }
    const cues = buildCues(tr.words);
    let he2, done;
    if (hebrew) { he2 = await correctHebrewCues(cues, { env, fetchImpl, log }); done = he2.length; }
    else { const t = await translateCues(cues, { env, fetchImpl, log }); he2 = t.cues; done = t.translated; if (!done) return null; }
    log.info?.('[SUBTITLES] Hebrew subtitles ready', { language, mode: hebrew ? 'hebrew_speech_written' : 'translated', cues: he2.length, done, model: tr.model, ms: Date.now() - t0 });
    return { srt: toSrt(he2), language, cues: he2.length, mode: hebrew ? 'hebrew' : 'translated' };
  } catch (e) {
    log.warn?.('[SUBTITLES] not added', { message: String(e?.message || e).slice(0, 200) });
    return null;
  }
}
