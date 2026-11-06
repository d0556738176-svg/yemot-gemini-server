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

// Backup transcription when Deepgram gives nothing (no credit, outage): Groq's
// Whisper with word timings. Returns the same shape as transcribeTimed.
export async function whisperTimed(audioFile, { env = process.env, fetchImpl = fetch, log = console, mime = 'audio/ogg', language } = {}) {
  const key = String(env.GROQ_API_KEY || '').trim();
  if (!key) return null;
  const body = await fs.readFile(audioFile);
  if (body.length > 24 * 1024 * 1024) { log.warn?.('[SUBTITLES] backup transcription skipped: audio too large', { bytes: body.length }); return null; }
  for (const model of ['whisper-large-v3', 'whisper-large-v3-turbo']) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([body], { type: mime }), mime === 'audio/mpeg' ? 'speech.mp3' : 'speech.ogg');
      fd.append('model', model);
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'word');
      fd.append('timestamp_granularities[]', 'segment');
      if (language) fd.append('language', language);
      const r = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: fd, signal: AbortSignal.timeout(15 * 60 * 1000) });
      const j = await r.json().catch(() => null);
      if (!r.ok) { log.warn?.('[SUBTITLES] backup transcription refused', { model, status: r.status, message: String(j?.error?.message || '').slice(0, 120) }); continue; }
      const words = (j?.words || []).map(w => ({ word: w.word, punctuated_word: String(w.word || '').trim(), start: Number(w.start), end: Number(w.end), confidence: 0.9 }));
      const lang = String(j?.language || '').toLowerCase();
      const code = /hebrew/.test(lang) ? 'he' : /english/.test(lang) ? 'en' : lang.slice(0, 2);
      log.info?.('[SUBTITLES] backup transcription', { model, language: code, words: words.length });
      if (words.length) return { language: code, words, conf: 0.9, setup: { model, language: code }, model: 'groq/' + model };
    } catch (e) { log.warn?.('[SUBTITLES] backup transcription failed', { model, message: String(e?.message || e).slice(0, 120) }); }
  }
  return null;
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
  const models = [...new Set(String(env.SUBTITLE_GEMINI_MODELS || env.GEMINI_MODELS || '').split(',').concat(['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash']).map(x => x.trim()).filter(Boolean))];
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
      console.warn('[SUBTITLES] Gemini answer not usable', { model, status: r.status, reason: String(j?.error?.message || j?.candidates?.[0]?.finishReason || 'lines did not match').slice(0, 120), lines: lines.length });
    } catch { /* next key */ }
  }
  return null;
}

// One group of lines -> Hebrew; a group that fails is split in half and
// retried, down to single lines, so a long video never keeps English lines.
async function translateGroup(texts, system, env, fetchImpl, log, depth = 0, ctx = { waited: 0, max: 10 * 60 * 1000 }) {
  let he = await geminiTranslate(texts, env, fetchImpl, system);
  for (let tryN = 0; !he && tryN < 2; tryN++) {
    he = parseLines(await groqChat([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(texts) }], { env, fetchImpl, maxTokens: 300 + texts.length * 120, timeoutMs: 60000 }), texts.length);
    if (!he && env.GROQ_API_KEY) await sleep(5000 * (tryN + 1)); // rate limit pacing
  }
  if (he) return he;
  if (texts.length > 1 && depth < 6) {
    const mid = Math.ceil(texts.length / 2);
    const a = await translateGroup(texts.slice(0, mid), system, env, fetchImpl, log, depth + 1, ctx);
    const b = await translateGroup(texts.slice(mid), system, env, fetchImpl, log, depth + 1, ctx);
    return [...a, ...b];
  }
  // A busy service is temporary: wait and try this group again before giving up.
  for (const wait of [20000, 60000, 120000]) {
    if (ctx.waited + wait > ctx.max) break; // total waiting per video is bounded
    ctx.waited += wait;
    await sleep(wait);
    he = await geminiTranslate(texts, env, fetchImpl, system)
      || parseLines(await groqChat([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(texts) }], { env, fetchImpl, maxTokens: 300 + texts.length * 120, timeoutMs: 60000 }), texts.length);
    if (he) return he;
  }
  log.warn?.('[SUBTITLES] line left as is', { text: texts[0]?.slice(0, 60) });
  return texts.map(() => null);
}

export async function translateCues(cues, { env = process.env, fetchImpl = fetch, log = console, batch = 25, system = SYSTEM, maxWaitMs = 10 * 60 * 1000 } = {}) {
  const out = [];
  const ctx = { waited: 0, max: maxWaitMs };
  let ok = 0;
  for (let i = 0; i < cues.length; i += batch) {
    const part = cues.slice(i, i + batch).map(c => c.text);
    const he = await translateGroup(part, system, env, fetchImpl, log, 0, ctx);
    part.forEach((t, k) => { if (he[k]) ok++; out.push({ ...cues[i + k], text: (he[k] || t).replace(/\s+/g, ' ').trim() }); });
  }
  if (ok < cues.length) log.warn?.('[SUBTITLES] some lines not translated', { translated: ok, of: cues.length });
  return { cues: out, translated: ok };
}

const CORRECT = 'אתה מגיה כתוביות בעברית. תקבל מערך JSON של שורות כתוביות שנוצרו מזיהוי דיבור אוטומטי של סרטון בעברית (שיר, הרצאה או דיבור). תקן שגיאות זיהוי וכתיב לפי ההקשר, הוסף פיסוק קל, בשפה נקייה. אל תוסיף ואל תשמיט תוכן, ואל תאחד או תפצל שורות. החזר רק מערך JSON של מחרוזות באותו אורך ובאותו סדר בדיוק.';

export async function correctHebrewCues(cues, { env = process.env, fetchImpl = fetch, log = console } = {}) {
  return (await translateCues(cues, { env, fetchImpl, log, system: CORRECT })).cues;
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
    let probe = await transcribeTimed(sample.file, { env, fetchImpl, log, mime: sample.mime, all: true, setups: [...DEEPGRAM_SETUPS, { model: 'nova-3', language: 'he' }] });
    await fs.rm(sample.file, { force: true }).catch(() => {});
    // Little speech in the sample (music, an opening): take another from the middle.
    if (seconds > 240 && Math.max(0, ...(probe?.tried || []).map(x => x.words.length)) < 20) {
      const mid = await extract('sample2', ['-ss', String(Math.floor(seconds * 0.5)), '-t', '180']);
      const p2 = await transcribeTimed(mid.file, { env, fetchImpl, log, mime: mid.mime, all: true, setups: [...DEEPGRAM_SETUPS, { model: 'nova-3', language: 'he' }] });
      await fs.rm(mid.file, { force: true }).catch(() => {});
      if (Math.max(0, ...(p2?.tried || []).map(x => x.words.length)) > Math.max(0, ...(probe?.tried || []).map(x => x.words.length))) probe = p2;
    }
    if (!probe?.tried?.length) {
      // Deepgram unavailable: the backup service does the whole job.
      const full0 = await extract('speech', []);
      const w = await whisperTimed(full0.file, { env, fetchImpl, log, mime: full0.mime });
      await fs.rm(full0.file, { force: true }).catch(() => {});
      if (!w || w.words.length < 5) return null;
      const cues0 = buildCues(w.words);
      const heb0 = /^(he|iw)/.test(w.language);
      const outCues = heb0 ? await correctHebrewCues(cues0, { env, fetchImpl, log }) : (await translateCues(cues0, { env, fetchImpl, log })).cues;
      log.info?.('[SUBTITLES] Hebrew subtitles ready', { language: w.language, mode: heb0 ? 'hebrew_speech_written' : 'translated', cues: outCues.length, model: w.model, backup: true, ms: Date.now() - t0 });
      return { srt: toSrt(outCues), language: w.language, cues: outCues.length, mode: heb0 ? 'hebrew' : 'translated' };
    }
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
    if (!tr?.words?.length) tr = await whisperTimed(full.file, { env, fetchImpl, log, mime: full.mime, language: hebrew ? 'he' : (language || undefined) });
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

// ---- Subtitles drawn into the picture (owner, 06.11) -----------------------
// Many players (phone galleries, Windows) do not show a subtitle track unless
// it is switched on, so the Hebrew lines are drawn into the picture itself.
// Lines are broken here (max ~42 letters, 2 lines) and each line is wrapped in
// right-to-left marks: libass then puts punctuation and numbers on the correct
// side (checked by eye on a rendered frame, 06.11).
const RLM = '\u200f';
export function wrapRtl(text, max = 42) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = []; let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  // Never more than 2 lines on screen: merge the rest into the second line.
  const two = lines.length > 2 ? [lines[0], lines.slice(1).join(' ')] : lines;
  return two.map(l => RLM + l + RLM).join('\n');
}

export function burnSrt(srt) {
  return String(srt).split(/\n\n+/).map(block => {
    const rows = block.split('\n');
    if (rows.length < 3) return block;
    return [rows[0], rows[1], wrapRtl(rows.slice(2).join(' '))].join('\n');
  }).join('\n\n') + '\n';
}

export async function fontsDir() {
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    return path.join(path.dirname(req.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
  } catch { return null; }
}

// Re-encodes the picture with the Hebrew lines drawn in (H.264, sound copied).
// Returns the new file path, or null if it failed or ran past maxMs.
export async function burnSubtitles(videoFile, srtText, tempDir, { ffmpegPath, log = console, maxMs = 3 * 3600 * 1000, height = null } = {}) {
  const fonts = await fontsDir();
  const srt = path.join(tempDir, 'burn.srt');
  await fs.writeFile(srt, burnSrt(srtText));
  const out = path.join(tempDir, 'burned.mp4');
  const esc = p => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const style = "FontName=DejaVu Sans,FontSize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=28,WrapStyle=2";
  const vf = (height ? "scale=-2:'min(" + height + ",ih)'," : '') + "subtitles='" + esc(srt) + "'" + (fonts ? ":fontsdir='" + esc(fonts) + "'" : '') + ":force_style='" + style + "'";
  const t0 = Date.now();
  const ok = await new Promise(resolve => {
    // Measured 06.11 on this server (0.15 CPU, 512 MB): 1080p veryfast ran over an
    // hour for 10 minutes of video and memory reached 500 MB. ultrafast, one
    // thread and a smaller picture (see height) keep it fast and safe.
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-stats', '-y', '-i', videoFile, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf,
      // ultrafast makes big files (the 10-minute Tesla video needed 7 parts):
      // a bitrate ceiling keeps them small (720p 1.8 Mb/s, 480p 0.9 Mb/s).
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-maxrate', (height && height <= 480 ? '900k' : '1800k'), '-bufsize', (height && height <= 480 ? '1800k' : '3600k'),
      '-pix_fmt', 'yuv420p', '-threads', '1', '-x264-params', 'rc-lookahead=10:ref=1',
      '-c:a', 'copy', '-movflags', '+faststart', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = '', lastLog = Date.now();
    p.stderr.on('data', d => {
      e = (e + d).slice(-300);
      if (Date.now() - lastLog > 120000) {
        lastLog = Date.now();
        const m = /time=(\d+):(\d+):(\d+)/.exec(String(d)); const sp = /speed=\s*([\d.]+)x/.exec(String(d));
        if (m) log.info?.('[SUBTITLES] drawing progress', { videoMinute: +((+m[1]) * 60 + (+m[2]) + (+m[3]) / 60).toFixed(1), speed: sp ? +sp[1] : null, minutesSoFar: +((Date.now() - t0) / 60000).toFixed(1) });
      }
    });
    const timer = setTimeout(() => { p.kill('SIGKILL'); log.warn?.('[SUBTITLES] drawing into the picture took too long; stopped', { minutes: Math.round(maxMs / 60000) }); }, maxMs);
    p.on('error', () => { clearTimeout(timer); resolve(false); });
    p.on('close', c => { clearTimeout(timer); if (c !== 0) log.warn?.('[SUBTITLES] drawing into the picture failed', { code: c, error: e.trim().slice(0, 200) }); resolve(c === 0); });
  });
  if (!ok) { await fs.rm(out, { force: true }).catch(() => {}); return null; }
  log.info?.('[SUBTITLES] Hebrew lines drawn into the picture', { minutes: +((Date.now() - t0) / 60000).toFixed(1) });
  return out;
}
