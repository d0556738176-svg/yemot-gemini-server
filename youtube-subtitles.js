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

export async function transcribeTimed(audioFile, { env = process.env, fetchImpl = fetch, log = console, mime = 'audio/ogg' } = {}) {
  const key = String(env.DEEPGRAM_API_KEY || '').trim();
  if (!key) return null;
  const body = await fs.readFile(audioFile);
  for (const model of ['nova-3', 'nova-2']) {
    const url = new URL('https://api.deepgram.com/v1/listen');
    url.searchParams.set('model', model);
    url.searchParams.set('detect_language', 'true');
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('punctuate', 'true');
    const r = await fetchImpl(url, { method: 'POST', headers: { Authorization: 'Token ' + key, 'Content-Type': mime }, body, signal: AbortSignal.timeout(20 * 60 * 1000) });
    const j = await r.json().catch(() => null);
    if (!r.ok) { log.warn?.('[SUBTITLES] transcription refused', { model, status: r.status, message: String(j?.err_msg || j?.message || '').slice(0, 160) }); continue; }
    const ch = j?.results?.channels?.[0];
    return { language: String(ch?.detected_language || ''), words: ch?.alternatives?.[0]?.words || [], model };
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

async function geminiTranslate(lines, env, fetchImpl) {
  const keys = String(env.GEMINI_API_KEYS || env.GEMINI_API_KEY || '').split(',').map(x => x.trim()).filter(Boolean);
  const models = String(env.SUBTITLE_GEMINI_MODELS || env.GEMINI_MODELS || 'gemini-3.6-flash,gemini-3.5-flash-lite').split(',').map(x => x.trim()).filter(Boolean);
  for (const model of models) for (const key of keys) {
    try {
      const r = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: JSON.stringify(lines) }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }),
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

// The whole thing for one local video file. Returns { srt, language, cues } or
// { skipped } / null.
export async function hebrewSubtitlesFor(videoFile, tempDir, { ffmpegPath, env = process.env, fetchImpl = fetch, log = console } = {}) {
  try {
    if (/^(0|false|off)$/i.test(String(env.VIDEO_HEBREW_SUBTITLES || ''))) return { skipped: 'disabled' };
    let audio = path.join(tempDir, 'speech.ogg'), mime = 'audio/ogg';
    try { await ffmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoFile, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', audio]); }
    catch { audio = path.join(tempDir, 'speech.mp3'); mime = 'audio/mpeg'; await ffmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoFile, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', audio]); }
    const t0 = Date.now();
    const tr = await transcribeTimed(audio, { env, fetchImpl, log, mime });
    await fs.rm(audio, { force: true }).catch(() => {});
    if (!tr) return null;
    const lang = tr.language.toLowerCase();
    if (/^(he|iw)/.test(lang)) { log.info?.('[SUBTITLES] speech is Hebrew; no subtitles needed', { language: lang }); return { skipped: 'hebrew', language: lang }; }
    if (tr.words.length < 5) { log.info?.('[SUBTITLES] almost no speech; no subtitles', { language: lang, words: tr.words.length }); return { skipped: 'no_speech', language: lang }; }
    const cues = buildCues(tr.words);
    const { cues: he, translated } = await translateCues(cues, { env, fetchImpl, log });
    if (!translated) return null;
    log.info?.('[SUBTITLES] Hebrew subtitles ready', { language: lang, cues: he.length, translated, model: tr.model, ms: Date.now() - t0 });
    return { srt: toSrt(he), language: lang, cues: he.length };
  } catch (e) {
    log.warn?.('[SUBTITLES] not added', { message: String(e?.message || e).slice(0, 200) });
    return null;
  }
}
