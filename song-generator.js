import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import ffmpegPath from './ffmpeg-path.js';
import { generateWithHuggingFaceSpace } from './song-generator-hf-space.js';
import { generateWithFalAceStep, isFalConfigured } from './song-engine-fal.js';
import { generateWithAceMusic, isAceMusicConfigured } from './song-engine-acemusic.js';
import { generateWithCloudWorker, isCloudWorkerConfigured, onOrphanSong } from './song-cloud.js';
import { publishSongToExt7, yemotToken } from './song-ext7.js';

const YEMOT_API_BASE = 'https://www.call2all.co.il/ym/api';
const MAX_AUDIO_BYTES = 35 * 1024 * 1024;
// Keep each Yemot playback chunk below the 90-second validation ceiling below.
export const YEMOT_AUDIO_CHUNK_SECONDS = 60;
// 60 s by default: the free CPU engine needs minutes per song (owner may ask longer).
const DEFAULT_DURATION_SECONDS = Math.max(30, Math.min(240, Number(process.env.SONG_DEFAULT_SECONDS || 60)));
const MAX_DURATION_SECONDS = 240;
const JOB_TIMEOUT_MS = Number(process.env.SONG_GENERATION_TIMEOUT_MS || 300000);
const activeJobs = new Map();
const providerHealth = new Map();
const rateBuckets = new Map();
const queue = [];
let activeCount = 0;
const MAX_CONCURRENT_JOBS = Math.max(1, Math.min(3, Number(process.env.SONG_MAX_CONCURRENT || 2)));
const MAX_QUEUE_SIZE = Math.max(0, Math.min(10, Number(process.env.SONG_MAX_QUEUE || 4)));

function log(event, details = {}) {
  console.info('[SONG]', event, details);
  if (/FAILED|ERROR|READY|REQUEST|SELECTED|TIMED|SKIPPED/.test(event)) noteSongEvent(event, details);
}
// Owner, 23.11: the last song events (no caller data), kept across restarts,
// shown in /health/songs so a failure's real reason can be read at once.
const SONG_EVENTS_FILE = process.env.SONG_EVENTS_FILE || '/var/lib/yemot-data/song-events.json';
let songEvents = null;
function loadSongEvents() {
  if (songEvents) return songEvents;
  try { songEvents = JSON.parse(readFileSync(SONG_EVENTS_FILE, 'utf8')); if (!Array.isArray(songEvents)) songEvents = []; } catch { songEvents = []; }
  return songEvents;
}
export function noteSongEvent(event, details = {}) {
  const list = loadSongEvents();
  const safe = {};
  for (const [k, v] of Object.entries(details || {})) {
    if (/phone|caller|userKey|prompt|lyrics|token|key/i.test(k)) continue;
    safe[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  list.push({ event, ...safe, at: new Date().toISOString() });
  if (list.length > 40) list.splice(0, list.length - 40);
  try { mkdirSync(dirname(SONG_EVENTS_FILE), { recursive: true }); writeFileSync(SONG_EVENTS_FILE + '.tmp', JSON.stringify(list)); renameSync(SONG_EVENTS_FILE + '.tmp', SONG_EVENTS_FILE); } catch {}
}
export function recentSongEvents() { return loadSongEvents().slice(-25); }

function statusOf(provider) {
  const state = providerHealth.get(provider);
  if (!state) return { status: 'available', cooldownUntil: 0 };
  if (state.cooldownUntil > Date.now()) return { ...state, status: state.status };
  // A transient or configuration failure must never disable a provider forever.
  // Once its bounded cooldown expires, allow a fresh health attempt.
  if (state.status !== 'available') providerHealth.set(provider, { status: 'available', cooldownUntil: 0 });
  return providerHealth.get(provider) || { status: 'available', cooldownUntil: 0 };
}

export function classifyProviderFailure(status, message = '') {
  const code = Number(status || 0);
  if (/zero.?gpu quota|free.{0,20}quota|requested GPU duration|quota.{0,30}(exceed|remaining)|try again in \\d/i.test(String(message || ''))) {
    return { status: 'rate_limited', cooldownMs: 12 * 60 * 60 * 1000 };
  }
  if (code === 429) return { status: 'rate_limited', cooldownMs: 60000 };
  if ([400, 413, 422].includes(code)) return { status: 'disabled', cooldownMs: 30000 };
  if ([401, 403, 404].includes(code)) return { status: 'disabled', cooldownMs: 60000 };
  // Network errors, timeouts, and 5xx responses are temporary unless proven otherwise.
  return { status: 'temporary_error', cooldownMs: 15000 };
}

async function readAudioResponseLimited(response, maxBytes, label) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) {
    throw Object.assign(new Error(label + ' exceeded size limit'), { status: 413 });
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > maxBytes) {
      throw Object.assign(new Error(label + ' is empty or exceeds size limit'), { status: buffer.length ? 413 : 502 });
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error(label + ' exceeded size limit'), { status: 413 });
    }
    chunks.push(Buffer.from(value));
  }
  if (!total) throw Object.assign(new Error(label + ' returned an empty audio file'), { status: 502 });
  return Buffer.concat(chunks, total);
}

function isSupportedAudioContentType(contentType) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  return type.startsWith('audio/') || type === 'application/octet-stream' || type === 'binary/octet-stream';
}

function markProvider(provider, status, cooldownMs = 0) {
  providerHealth.set(provider, { status, cooldownUntil: Date.now() + cooldownMs });
  log('PROVIDER_HEALTH', { provider, status });
}

export function shouldFallbackToBackup(status) {
  const code = Number(status || 0);
  return code !== 400 && code !== 413 && code !== 422;
}

function httpStatus(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (status) return status;
  const m = String(error?.message || error || '').match(/\b(429|500|502|503|504|408)\b/);
  return m ? Number(m[1]) : 0;
}

function parseJsonObject(value) {
  const text = String(value || '').trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
    // Owner, 23.11: long lyrics often come back with real line breaks inside
    // the "lyrics" string, which is not valid JSON; they are escaped here.
    let inStr = false, esc = false, out = '';
    for (const ch of match[0]) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      out += inStr && ch === '\n' ? '\\n' : inStr && ch === '\r' ? '' : inStr && ch === '\t' ? ' ' : ch;
    }
    try {
      const parsed = JSON.parse(out);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  throw new Error('Song LLM did not return valid JSON');
}

export function normalizeSongRequest(request = {}) {
  const prompt = String(request.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 700);
  const requestedDuration = Number(request.duration_seconds || DEFAULT_DURATION_SECONDS);
  const durationSeconds = Math.max(30, Math.min(MAX_DURATION_SECONDS,
    Number.isFinite(requestedDuration) ? Math.round(requestedDuration) : DEFAULT_DURATION_SECONDS));
  return { prompt, durationSeconds };
}

export async function generateSongSpec(request, generateText) {
  const normalized = normalizeSongRequest(request);
  if (!normalized.prompt || normalized.prompt.length < 3) {
    throw Object.assign(new Error('Song request is too short'), { code: 'NEEDS_CLARIFICATION' });
  }
  const llmPrompt = [
    'אתה מפיק שירים מקצועי. צור מפרט לשיר מקורי לחלוטין בעברית כברירת מחדל.',
    'החזר JSON תקין בלבד, ללא Markdown, עם השדות:',
    '{"title":"...","language":"he","genre":"...","mood":"...","tempo":"...","duration_seconds":180,"lyrics":"...","music_prompt":"...","needs_clarification":false,"clarification_question":""}',
    'אם הבקשה אינה ברורה מספיק כדי ליצור שיר סביר, החזר needs_clarification=true ושאלה קצרה בשדה clarification_question.',
    'כתוב מילים מקוריות בלבד; אל תצטט שיר קיים ואל תבקש חיקוי מדויק של אמן מסוים.',
    'במילים השתמש בסימוני מבנה [Intro], [Verse 1], [Chorus], [Verse 2], [Outro] לפי הצורך.',
    'הגבל את אורך השיר ל-30 עד 240 שניות. ברירת המחדל היא ' + normalized.durationSeconds + ' שניות.',
    'genre, mood, tempo ו-music_prompt חייבים להיות באנגלית כדי שמנוע המוזיקה יבין אותם. שמור את מילות השיר בשפה שביקש המתקשר.',
    'המילים נקיות, מכובדות ומתאימות לכל המשפחה.',
    'מילים שהמתקשר הכתיב: אם המתקשר אמר מילים מסוימות לשיר (למשל "המילים הן...", "שישיר...", או שורות שירה שאמר), השתמש בדיוק במילים שלו כפי שנאמרו, בלי לשנות ובלי לקצר; רק חלק אותן לבתים ולפזמון והוסף סימוני מבנה. אם אמר רק חלק מהמילים, השלם את השאר באותו סגנון ובאותו נושא.',
    'קול השירה לפי בקשת המתקשר, ובאנגלית בתוך music_prompt: גבר או ברירת מחדל = "adult male lead vocals"; ילד או בן קטן = "young boy lead vocals, child singer"; ילדה או בת קטנה = "young girl lead vocals, child singer"; מקהלת ילדים = "children\'s choir"; מקהלה = "male choir"; בלי שירה = "instrumental, no vocals". אם לא ביקש קול מסוים, השתמש בקול גברי.',
    'אם המתקשר ביקש "בסגנון של" זמר או להקה, אל תכתוב את השם ב-music_prompt ואל תחקה את הקול שלו; תרגם את הבקשה לתיאור הסגנון המוזיקלי עצמו באנגלית (ז\'אנר, כלים, קצב, אווירה), למשל "Mizrahi pop ballad, oud, strings, emotional".',
    'קאבר או "שיר X במילים אחרות": כתוב מילים חדשות ומקוריות לגמרי בנושא שהמתקשר ביקש, ותאר ב-music_prompt את הסגנון המוזיקלי של השיר המקורי (ז\'אנר, קצב, כלים, אווירה) בלי שם השיר והאמן ובלי להעתיק את הלחן או את המילים שלו.',
    'ב-music_prompt פרט באנגלית: ז\'אנר, כלי נגינה, קצב (BPM), אווירה וקול השירה, כדי שהשיר ייצא כמו שביקש.',
    'שיר קצר עדיף: עד 4 בתים קצרים ופזמון, כדי שהמילים ייכנסו במשך הזמן.',
    'בקשת המתקשר: ' + normalized.prompt,
    'משך מבוקש בשניות: ' + normalized.durationSeconds
  ].join('\n');
  const raw = await generateText(llmPrompt);
  const spec = parseJsonObject(raw);
  if (spec.needs_clarification) {
    return {
      needsClarification: true,
      clarificationQuestion: String(spec.clarification_question || 'איזה סגנון מוזיקלי תרצה?').slice(0, 180)
    };
  }
  const title = String(spec.title || 'השיר שלי').trim().slice(0, 120);
  const lyrics = String(spec.lyrics || '').trim().slice(0, 5000);
  const genre = String(spec.genre || 'pop').trim().slice(0, 100);
  const mood = String(spec.mood || 'upbeat').trim().slice(0, 100);
  const musicPrompt = String(spec.music_prompt || (genre + ', ' + mood)).trim().slice(0, 1000);
  if (!lyrics || !musicPrompt) throw new Error('Song LLM returned incomplete song data');
  return {
    needsClarification: false,
    title, language: String(spec.language || 'he').slice(0, 12),
    genre, mood, tempo: String(spec.tempo || 'mid-tempo').slice(0, 60),
    durationSeconds: normalizeSongRequest({ prompt: normalized.prompt, duration_seconds: spec.duration_seconds || normalized.durationSeconds }).durationSeconds,
    lyrics, musicPrompt
  };
}

function splitLyrics(lyrics, durationSeconds, spec) {
  const lines = String(lyrics || '').split(/\r?\n/);
  const sections = [];
  let current = { name: 'Verse 1', lines: [] };
  const heading = /^\s*\[(intro|verse\s*\d*|chorus|bridge|outro|pre-chorus|post-chorus|instrumental|פזמון|בית\s*\d*)\]\s*$/i;
  for (const line of lines) {
    const match = line.match(heading);
    if (match) {
      if (current.lines.length || !sections.length) sections.push(current);
      current = { name: match[1].trim(), lines: [] };
    } else if (line.trim()) {
      current.lines.push(line.trim().slice(0, 200));
    }
  }
  if (current.lines.length || !sections.length) sections.push(current);
  const useful = sections.filter(section => section.lines.length).slice(0, 6);
  if (!useful.length) useful.push({ name: 'Song', lines: [String(lyrics).slice(0, 200)] });

  // ACE-Step acestep-v15-turbo expects composition_plan.chunks, not the legacy
  // sections/lines schema used by older model versions.
  const totalMs = Math.max(3000 * useful.length, durationSeconds * 1000);
  const baseMs = Math.floor(totalMs / useful.length / 1000) * 1000;
  let remaining = totalMs;
  return useful.map((section, index) => {
    const duration = index === useful.length - 1 ? remaining : baseMs;
    remaining -= duration;
    const text = '[' + section.name + ']\n' + section.lines.join('\n');
    return {
      text: text.slice(0, 6132),
      duration_ms: duration,
      positive_styles: [spec.genre, spec.mood, spec.musicPrompt, spec.tempo, 'clear vocals']
        .filter(Boolean).map(value => String(value).slice(0, 180)).slice(0, 10),
      negative_styles: ['unintelligible vocals', 'abrupt ending'],
      context_adherence: 'high'
    };
  });
}

export function buildCompositionPlan(spec) {
  return { chunks: splitLyrics(spec.lyrics, spec.durationSeconds, spec) };
}

async function fetchWithTimeout(url, options, timeoutMs, label) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }).catch(error => {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw Object.assign(new Error(label + ' timed out'), { status: 408 });
    }
    throw error;
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw Object.assign(new Error(label + ' HTTP ' + response.status + ': ' + body.slice(0, 250)), { status: response.status });
  }
  return response;
}

export function buildAceStepPayload(spec) {
  const duration = Math.max(30, Math.min(MAX_DURATION_SECONDS, Math.round(Number(spec.durationSeconds) || DEFAULT_DURATION_SECONDS)));
  return {
    prompt: String(spec.musicPrompt || [spec.genre, spec.mood, spec.tempo, 'full song with clear lead vocals'].filter(Boolean).join(', ')).slice(0, 1800),
    lyrics: String(spec.lyrics || '').slice(0, 8000),
    vocal_language: String(spec.language || 'he').slice(0, 24),
    audio_duration: duration,
    thinking: true,
    use_format: false,
    use_cot_caption: true,
    use_cot_language: true,
    model: String(process.env.ACESTEP_MODEL || 'acestep-v15-turbo'),
    task_type: 'text2music',
    audio_format: 'mp3',
    inference_steps: 8,
    batch_size: 1,
    use_random_seed: true
  };
}

function aceStepApiBase() {
  const raw = String(process.env.ACESTEP_API_URL || '').trim();
  if (!raw) throw Object.assign(new Error('ACE-Step API is not configured'), { status: 503, provider: 'ace-step' });
  const base = new URL(raw);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
    throw new Error('ACE-Step API URL must use HTTPS outside localhost');
  }
  base.pathname = base.pathname.replace(/\/$/, '');
  return base;
}

function aceStepHeaders(json = false) {
  const key = String(process.env.ACESTEP_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error('ACESTEP_API_KEY is missing'), { status: 503, provider: 'ace-step' });
  return { authorization: 'Bearer ' + key, ...(json ? { 'content-type': 'application/json' } : {}) };
}

function unwrapAceStepData(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('ACE-Step returned invalid JSON');
  if (Number(payload.code || 200) >= 400 || payload.error) {
    throw Object.assign(new Error('ACE-Step API error: ' + String(payload.error || payload.message || 'unknown error').slice(0, 240)), { status: Number(payload.code || 502) });
  }
  return payload.data;
}

function parseAceStepResult(result) {
  if (Array.isArray(result)) return result;
  if (typeof result === 'string') {
    try { const parsed = JSON.parse(result); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  return [];
}

// The private ACE-Step server scales to zero when idle. Waking it the moment a
// caller enters extension 4 lets the GPU boot while they are still speaking,
// instead of after the lyrics are ready. Deduplicated; never throws.
let aceWarmUntil = 0;
let aceWarmPromise = null;
export function warmMusicEngine() {
  try {
    if (!String(process.env.ACESTEP_API_URL || '').trim()) return null;
    if (aceWarmPromise || Date.now() < aceWarmUntil) return aceWarmPromise;
    const url = new URL('/health', aceStepApiBase());
    const startedAt = Date.now();
    aceWarmPromise = fetch(url, { headers: aceStepHeaders(false), signal: AbortSignal.timeout(900000) })
      .then(r => { log('ACE_STEP_WARM', { status: r.status, ms: Date.now() - startedAt }); if (r.ok) aceWarmUntil = Date.now() + 45000; })
      .catch(error => log('ACE_STEP_WARM_FAILED', { message: String(error?.message || error).slice(0, 120) }))
      .finally(() => { aceWarmPromise = null; });
    return aceWarmPromise;
  } catch { return null; }
}

export async function generateWithAceStep(spec) {
  const base = aceStepApiBase();
  const headers = aceStepHeaders(true);
  // Default leaves room for a cold GPU boot (~2-5 min) plus generation.
  const totalTimeout = Math.max(30000, Math.min(600000, Number(process.env.SONG_GENERATION_TIMEOUT_MS || 540000)));
  const startedAt = Date.now();
  const submitUrl = new URL('/release_task', base);
  const submitted = await fetchWithTimeout(submitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildAceStepPayload(spec))
  }, totalTimeout, 'ACE-Step task submission'); // a cold GPU server holds this request while it boots
  const submitData = unwrapAceStepData(await submitted.json());
  const taskId = String(submitData?.task_id || submitData?.taskId || '').trim();
  if (!taskId) throw new Error('ACE-Step did not return a task_id');

  log('ACE_STEP_TASK_SUBMITTED', { taskId, durationSeconds: spec.durationSeconds });
  const queryUrl = new URL('/query_result', base);
  let audioPath = '';
  while (Date.now() - startedAt < totalTimeout) {
    await new Promise(resolve => setTimeout(resolve, 1800));
    const queried = await fetchWithTimeout(queryUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ task_id_list: [taskId] })
    }, Math.min(15000, totalTimeout), 'ACE-Step status query');
    const queryData = unwrapAceStepData(await queried.json());
    const row = Array.isArray(queryData) ? queryData.find(item => String(item?.task_id) === taskId) || queryData[0] : null;
    if (!row) continue;
    const status = Number(row.status);
    if (status === 2) throw Object.assign(new Error('ACE-Step generation failed'), { status: 502, provider: 'ace-step' });
    if (status !== 1) continue;

    const resultRows = parseAceStepResult(row.result);
    const fileValue = String(resultRows[0]?.file || '').trim();
    if (!fileValue) throw new Error('ACE-Step completed without an audio file path');
    const audioUrl = new URL(fileValue, base);
    if (audioUrl.origin !== base.origin || audioUrl.pathname !== '/v1/audio') {
      throw new Error('ACE-Step returned an unexpected audio URL');
    }
    audioPath = audioUrl.toString();
    break;
  }
  if (!audioPath) throw Object.assign(new Error('ACE-Step generation timed out'), { status: 408, provider: 'ace-step' });

  const audioResponse = await fetchWithTimeout(audioPath, {
    method: 'GET',
    headers: aceStepHeaders(false)
  }, Math.min(30000, totalTimeout), 'ACE-Step audio download');
  const type = String(audioResponse.headers.get('content-type') || '').toLowerCase();
  if (!isSupportedAudioContentType(type)) {
    throw Object.assign(new Error('ACE-Step returned a non-audio response'), { status: 502, provider: 'ace-step' });
  }
  const audio = await readAudioResponseLimited(audioResponse, MAX_AUDIO_BYTES, 'ACE-Step audio');
  return { audio, provider: 'ace-step', model: String(process.env.ACESTEP_MODEL || 'acestep-v15-turbo'), contentType: type };
}

async function generateWithBackup(spec) {
  const endpoint = String(process.env.MUSIC_BACKUP_API_URL || '').trim();
  const key = String(process.env.MUSIC_BACKUP_API_KEY || '').trim();
  if (!endpoint || !key) throw Object.assign(new Error('No backup music provider is configured'), { status: 503, provider: 'backup' });
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('Backup music provider URL must use HTTPS');
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'audio/mpeg,application/octet-stream' },
    body: JSON.stringify({
      title: spec.title, lyrics: spec.lyrics, genre: spec.genre, mood: spec.mood,
      duration_seconds: spec.durationSeconds, music_prompt: spec.musicPrompt,
      model: String(process.env.MUSIC_BACKUP_MODEL || 'configured-provider')
    })
  }, Math.min(JOB_TIMEOUT_MS, 90000), 'Backup music provider');
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('application/json')) throw new Error('Backup provider contract requires an audio-byte response, not JSON');
  if (!isSupportedAudioContentType(type)) {
    throw Object.assign(new Error('Backup provider returned a non-audio response'), { status: 502 });
  }
  const audio = await readAudioResponseLimited(response, MAX_AUDIO_BYTES, 'Backup audio');
  return { audio, provider: 'backup', model: String(process.env.MUSIC_BACKUP_MODEL || 'configured-provider'), contentType: type };
}

// Ordered music engines. The official free ACE-Step cloud (acemusic.ai) is
// first, then a private ACE-Step server if one is configured, then the free
// Hugging Face Space; paid/optional hosts last.
// Each engine is skipped while cooling down after a failure, so a dead engine
// never makes the caller wait twice.
function musicProviders() {
  const env = process.env;
  return [
    {
      id: 'acemusic',
      configured: () => isAceMusicConfigured(env),
      run: spec => generateWithAceMusic(spec, env)
    },
    {
      id: 'ace-step',
      configured: () => !!String(env.ACESTEP_API_URL || '').trim() && !!String(env.ACESTEP_API_KEY || '').trim(),
      run: generateWithAceStep
    },
    {
      // 24.11: the official ACE-Step Space on a free GPU (about a minute) goes
      // before the CPU runner whenever a Hugging Face token is set.
      id: 'huggingface-space-first',
      configured: () => !!String(env.HF_TOKEN || '').trim() && String(env.HF_MUSIC_SPACE_ENABLED || '').toLowerCase() !== 'false',
      run: generateWithHuggingFaceSpace
    },
    {
      // Free: the official model on a GitHub Actions runner (CPU, minutes).
      id: 'github-cpu',
      configured: () => isCloudWorkerConfigured(),
      run: (spec, meta) => generateWithCloudWorker(spec, meta)
    },
    {
      id: 'huggingface-space',
      configured: () => String(env.HF_MUSIC_SPACE_ENABLED || '').toLowerCase() === 'true',
      run: generateWithHuggingFaceSpace
    },
    {
      id: 'fal-ace-step',
      configured: () => isFalConfigured(),
      run: generateWithFalAceStep
    },
    {
      id: 'backup',
      configured: () => !!String(env.MUSIC_BACKUP_API_URL || '').trim() && !!String(env.MUSIC_BACKUP_API_KEY || '').trim(),
      run: generateWithBackup
    }
  ];
}

async function generateAudio(spec, meta = {}) {
  const errors = [];
  let anyConfigured = false;
  for (const provider of musicProviders()) {
    if (!provider.configured()) continue;
    anyConfigured = true;
    const state = statusOf(provider.id);
    if (state.status === 'disabled' || state.cooldownUntil > Date.now()) {
      log('MUSIC_PROVIDER_SKIPPED', { provider: provider.id, status: state.status });
      continue;
    }
    try {
      log('MUSIC_PROVIDER_SELECTED', { provider: provider.id });
      const result = await provider.run(spec, meta);
      markProvider(provider.id, 'available');
      return result;
    } catch (error) {
      errors.push(error);
      const status = httpStatus(error);
      const failure = classifyProviderFailure(status, error?.message);
      markProvider(provider.id, failure.status, failure.cooldownMs);
      log('MUSIC_PROVIDER_FAILED', { provider: provider.id, status: status || 'unknown', message: String(error?.message || '').slice(0, 160) });
      if (!shouldFallbackToBackup(status)) throw error;
    }
  }
  if (errors.length) throw errors[0];
  throw Object.assign(new Error(anyConfigured
    ? 'All music providers are cooling down after recent failures'
    : 'No music provider is configured'), { status: 503 });
}

function runFfmpeg(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg-static is unavailable'));
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('Audio conversion timed out'), { status: 408 }));
    }, timeoutMs);
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Audio conversion failed (' + code + '): ' + stderr.slice(-1000)));
    });
  });
}

// The engine's master file: FLAC (lossless, 48 kHz stereo, since 15.11) or
// MP3 from older runs. Decided from the bytes, never from a guess.
export function masterExt(audio) {
  const head = Buffer.from(audio || []).subarray(0, 4).toString('latin1');
  if (head === 'fLaC') return 'flac';
  if (head === 'RIFF') return 'wav';
  return 'mp3';
}

async function convertToYemotWavChunks(audio, tempDir) {
  const mp3Path = path.join(tempDir, 'source.' + masterExt(audio));
  const chunksDir = path.join(tempDir, 'chunks');
  await fs.mkdir(chunksDir, { recursive: true });
  await fs.writeFile(mp3Path, audio);
  const pattern = path.join(chunksDir, 'song-%03d.wav');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y', '-i', mp3Path,
    '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le',
    '-f', 'segment', '-segment_time', String(YEMOT_AUDIO_CHUNK_SECONDS), '-reset_timestamps', '1', pattern
  ]);
  const names = (await fs.readdir(chunksDir)).filter(name => /^song-\d{3}\.wav$/.test(name)).sort();
  if (!names.length) throw new Error('Audio converter produced no WAV files');
  const files = [];
  for (const name of names) {
    const file = path.join(chunksDir, name);
    const stat = await fs.stat(file);
    if (stat.size < 16044) throw new Error('Converted audio file is empty or too short');
    const wav = await fs.readFile(file);
    const header = wav.subarray(0, 4).toString('ascii');
    if (header !== 'RIFF') throw new Error('Converted audio file is not a WAV/RIFF file');
    const estimatedSeconds = Math.max(0, (stat.size - 44) / 16000);
    if (estimatedSeconds < 1 || estimatedSeconds > 90) throw new Error('Converted audio duration is outside the safe range');
    files.push(file);
  }
  return files;
}

function yemotKey() {
  const key = yemotToken();
  if (!key) throw new Error('Yemot API credentials are not configured');
  return key;
}

async function uploadWavToYemot(filePath, remotePath) {
  const buffer = await fs.readFile(filePath);
  const url = new URL(YEMOT_API_BASE + '/UploadFile');
  url.searchParams.set('token', yemotKey());
  url.searchParams.set('path', remotePath);
  url.searchParams.set('convertAudio', '1');
  url.searchParams.set('autoNumbering', 'false');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), path.basename(filePath));
  const response = await fetchWithTimeout(url, { method: 'POST', body: form }, 20000, 'Yemot audio upload');
  const result = await response.json().catch(() => ({}));
  if (result.responseStatus && result.responseStatus !== 'OK') throw new Error('Yemot upload failed: ' + String(result.message || result.responseStatus));
  if (result.success === false) throw new Error('Yemot upload failed');
  return result;
}

async function verifyYemotFile(remotePath) {
  const url = new URL(YEMOT_API_BASE + '/GetFile');
  url.searchParams.set('token', yemotKey());
  url.searchParams.set('what', remotePath);
  const response = await fetchWithTimeout(url, {}, 8000, 'Yemot audio verification');
  const result = await response.json().catch(() => ({}));
  if (result.responseStatus !== 'OK') throw new Error('Yemot audio file was not verified');
  return result;
}

async function storeMp3IfConfigured(audio, uuid) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_KEY || '').trim();
  const bucket = String(process.env.SONG_STORAGE_BUCKET || '').trim();
  if (!base || !key || !bucket) return null;
  const objectPath = 'songs/' + uuid + '.mp3';
  const url = base + '/storage/v1/object/' + encodeURIComponent(bucket) + '/' + objectPath.split('/').map(encodeURIComponent).join('/');
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'audio/mpeg', 'x-upsert': 'false' },
    body: audio
  }, 20000, 'Supabase song storage');
  await response.arrayBuffer().catch(() => null);
  return 'supabase://' + bucket + '/' + objectPath;
}

async function saveSongRecord(record, method = 'POST') {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_KEY || '').trim();
  if (!base || !key) return;
  try {
    const url = new URL(base + '/rest/v1/generated_songs');
    if (method === 'PATCH') url.searchParams.set('id', 'eq.' + record.id);
    const response = await fetch(url, {
      method,
      headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('Supabase generated_songs HTTP ' + response.status);
  } catch (error) {
    log('STORAGE_METADATA_FAILED', { status: httpStatus(error) || 'unknown' });
  }
}

// One full 8kHz mono WAV of the whole song, for extension 7.
async function convertToSingleWav(audio, tempDir) {
  const src = path.join(tempDir, 'full-source.' + masterExt(audio));
  const out = path.join(tempDir, 'full.wav');
  await fs.writeFile(src, audio);
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', out], 60000);
  return fs.readFile(out);
}

// Converts, uploads (extension 4 playback chunks + one file in extension 7)
// and records a generated song. Shared by the live call path and by songs
// that arrive after the caller already hung up.
// The song as a file to download, in the same אודיו / אודיו_2 ... folders as
// extension 2 (shared counter, real file count decides), with its details:
// name, "AI song" as the singer, style, the full lyrics, date and the request.
export async function saveSongDownloadCopy(audio, spec, uuid, tempDir, { upload = uploadRawToYemot, getFile = yemotFileMeta, folders = null } = {}) {
  const f = folders || await import('./download-folders.js');
  const src = path.join(tempDir, 'ai-source.' + masterExt(audio)), out = path.join(tempDir, 'ai-download.mp3');
  await fs.writeFile(src, audio);
  const now = new Date();
  const title = String(spec.title || 'שיר חדש').trim().slice(0, 120);
  const tags = {
    title, artist: 'שיר בינה מלאכותית', album_artist: 'שלוחה 4', album: 'שירי בינה מלאכותית', composer: 'בינה מלאכותית',
    genre: [spec.genre, spec.mood].filter(Boolean).join(', ').slice(0, 120) || 'שיר', date: now.toISOString().slice(0, 10), year: String(now.getUTCFullYear()),
    lyrics: String(spec.lyrics || '').trim().slice(0, 8000),
    comment: ['נוצר בשלוחה 4', now.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }), spec.style || spec.prompt || ''].filter(Boolean).join(' | ').slice(0, 400),
    encoded_by: 'Yemot branch 4'
  };
  // An mp3 master is kept bit for bit; a lossless master becomes a 320k mp3
  // (the best mp3 there is) - the lossless file itself goes to "שירי AI".
  const codec = masterExt(audio) === 'mp3' ? ['-c', 'copy'] : ['-c:a', 'libmp3lame', '-b:a', '320k'];
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0:a', ...codec, '-id3v2_version', '3', '-write_id3v1', '1'];
  for (const [k, v] of Object.entries(tags)) if (v) args.push('-metadata', k + '=' + v);
  args.push(out);
  await runFfmpeg(args, 60000);
  const io = { readJson: readYemotJson, writeJson: writeYemotJson };
  const folder = await f.nextFolder('audio', { ...io, countFiles: p => f.yemotFileCount(p, { apiBase: YEMOT_API_BASE, token: yemotKey() }) });
  const clean = title.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'שיר';
  const remote = folder + '/שיר AI - ' + clean + ' - ' + uuid.slice(0, 6) + '.mp3';
  const bytes = (await fs.stat(out)).size;
  let last = null;
  for (const [i, w] of [0, 15000, 45000, 120000].entries()) {
    if (w) await new Promise(r => setTimeout(r, w));
    try {
      await upload(out, remote);
      const m = await getFile(remote);
      if (m?.file?.exists === true && Number(m?.file?.size) === bytes) { last = null; break; }
      last = new Error('download copy not verified in Yemot');
    } catch (e) { last = e; }
    log('DOWNLOAD_COPY_RETRY', { id: uuid, attempt: i + 1, message: String(last?.message || last).slice(0, 120) });
  }
  if (last) throw last;
  await f.countSaved('audio', io).catch(() => {});
  log('DOWNLOAD_COPY_SAVED', { id: uuid, remote, bytes });
  return { remote, bytes };
}

// 15.11 (owner): a folder "שירי AI" with every AI song in the best quality
// there is (the engine's lossless FLAC master, untouched) and every detail in
// the file itself, the full lyrics included. Over 2,900 files it continues in
// "שירי AI_2" and so on (Yemot's per-folder limit), counted in Yemot itself.
export const AI_SONGS_BASE = 'ivr2:/שירי AI';
export function aiSongTags(spec, meta = {}) {
  const now = meta.now || new Date();
  const local = now.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const style = [spec.genre, spec.mood, spec.tempo].filter(Boolean).join(', ');
  return {
    title: String(spec.title || 'שיר חדש').trim().slice(0, 120),
    artist: 'שיר בינה מלאכותית',
    album_artist: 'שלוחה 4 - יוצר השירים',
    album: 'שירי AI',
    composer: 'בינה מלאכותית (ACE-Step 1.5)',
    lyricist: 'בינה מלאכותית',
    genre: style.slice(0, 160) || 'שיר',
    date: now.toISOString().slice(0, 10),
    year: String(now.getUTCFullYear()),
    language: String(spec.language || 'he'),
    lyrics: String(spec.lyrics || '').trim().slice(0, 8000),
    description: String(spec.musicPrompt || '').slice(0, 1000),
    comment: ['נוצר בשלוחה 4', local, meta.request ? 'בקשה: ' + meta.request : ''].filter(Boolean).join(' | ').slice(0, 1000),
    request: String(meta.request || '').slice(0, 1000),
    style: String(spec.musicPrompt || '').slice(0, 1000),
    created: now.toISOString(),
    duration_requested: String(spec.durationSeconds || ''),
    engine: String(meta.engine || 'ACE-Step 1.5 turbo'),
    song_id: String(meta.id || ''),
    encoded_by: 'Yemot branch 4'
  };
}

export async function saveSongToAiFolder(audio, spec, uuid, tempDir, { upload = uploadRawToYemot, getFile = yemotFileMeta, countFiles = null, request = '', engine = '', now = new Date() } = {}) {
  const ext = masterExt(audio);
  const src = path.join(tempDir, 'ai-folder-source.' + ext);
  const out = path.join(tempDir, 'ai-folder.' + ext);
  await fs.writeFile(src, audio);
  const tags = aiSongTags(spec, { request, engine, id: uuid, now });
  // Stream copied as is (no re-encoding); only the details are written.
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0:a', '-c', 'copy'];
  if (ext === 'mp3') args.push('-id3v2_version', '3', '-write_id3v1', '1');
  for (const [k, v] of Object.entries(tags)) if (v) args.push('-metadata', k + '=' + v);
  args.push(out);
  await runFfmpeg(args, 60000);
  const count = countFiles || (async p => (await import('./download-folders.js')).yemotFileCount(p, { apiBase: YEMOT_API_BASE, token: yemotKey() }));
  let folder = AI_SONGS_BASE;
  for (let n = 1; n < 50; n++) {
    folder = n === 1 ? AI_SONGS_BASE : AI_SONGS_BASE + '_' + n;
    const real = await count(folder).catch(() => null);
    if (!Number.isFinite(real) || real < 2900) break;
  }
  const clean = tags.title.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'שיר';
  const remote = folder + '/' + clean + ' - ' + uuid.slice(0, 6) + '.' + ext;
  const bytes = (await fs.stat(out)).size;
  let last = null;
  for (const [i, w] of [0, 15000, 45000, 120000].entries()) {
    if (w) await new Promise(r => setTimeout(r, w));
    try {
      await upload(out, remote, ext === 'flac' ? 'audio/flac' : 'audio/mpeg');
      const m = await getFile(remote);
      if (m?.file?.exists === true && Number(m?.file?.size) === bytes) { last = null; break; }
      last = new Error('AI songs folder copy not verified in Yemot');
    } catch (e) { last = e; }
    log('AI_FOLDER_RETRY', { id: uuid, attempt: i + 1, message: String(last?.message || last).slice(0, 120) });
  }
  if (last) throw last;
  log('AI_FOLDER_SAVED', { id: uuid, remote, bytes, format: ext });
  return { remote, bytes, format: ext };
}

async function uploadRawToYemot(filePath, remotePath, type = 'audio/mpeg') {
  const buffer = await fs.readFile(filePath);
  const url = new URL(YEMOT_API_BASE + '/UploadFile');
  url.searchParams.set('token', yemotKey());
  url.searchParams.set('path', remotePath);
  url.searchParams.set('convertAudio', '0');
  url.searchParams.set('autoNumbering', 'false');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), path.basename(remotePath));
  const response = await fetchWithTimeout(url, { method: 'POST', body: form }, Math.max(120000, Math.ceil(buffer.length / 100000) * 1000), 'Yemot download copy upload');
  const result = await response.json().catch(() => ({}));
  if (result.responseStatus && result.responseStatus !== 'OK') throw new Error('Yemot upload failed: ' + String(result.message || result.responseStatus));
  return result;
}
async function yemotFileMeta(remotePath) {
  const url = new URL(YEMOT_API_BASE + '/GetFile');
  url.searchParams.set('token', yemotKey()); url.searchParams.set('what', remotePath);
  return (await fetchWithTimeout(url, {}, 15000, 'Yemot file check')).json().catch(() => ({}));
}
async function readYemotJson(what) {
  const url = new URL(YEMOT_API_BASE + '/GetTextFile');
  url.searchParams.set('token', yemotKey()); url.searchParams.set('what', what);
  const j = await (await fetchWithTimeout(url, {}, 15000, 'Yemot text read')).json().catch(() => ({}));
  try { return JSON.parse(j?.contents || 'null'); } catch { return null; }
}
async function writeYemotJson(what, data) {
  const url = new URL(YEMOT_API_BASE + '/UploadTextFile');
  url.searchParams.set('token', yemotKey()); url.searchParams.set('what', what); url.searchParams.set('contents', JSON.stringify(data));
  await fetchWithTimeout(url, { method: 'POST' }, 15000, 'Yemot text write');
}

async function deliverSong(spec, generated, job, record, uuid) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'song-generator-'));
  try {
    record.provider = generated.provider;
    record.model = generated.model;
    job.status = 'downloading';
    log('AUDIO_DOWNLOADED', { id: uuid, bytes: generated.audio.length, provider: generated.provider });
    const archived = await storeMp3IfConfigured(generated.audio, uuid).catch(error => {
      log('AUDIO_ARCHIVE_FAILED', { id: uuid, status: httpStatus(error) || 'unknown' });
      return null;
    });
    job.status = 'converting';
    const wavFiles = await convertToYemotWavChunks(generated.audio, tempDir);
    log('AUDIO_CONVERTED', { id: uuid, chunks: wavFiles.length });
    job.status = 'uploading';
    const playbackPaths = [];
    for (let i = 0; i < wavFiles.length; i++) {
      const remote = 'ivr2:/4/songs/' + uuid + '-' + String(i + 1).padStart(3, '0') + '.wav';
      await uploadWavToYemot(wavFiles[i], remote);
      await verifyYemotFile(remote);
      playbackPaths.push('/4/songs/' + uuid + '-' + String(i + 1).padStart(3, '0'));
    }
    // Extension 7 keeps every song (owner, 13.11). Never fails the song.
    let ext7 = null;
    try {
      const wav = await convertToSingleWav(generated.audio, tempDir);
      ext7 = await publishSongToExt7('ai-song-' + uuid, wav, 'שיר AI: ' + (spec.title || 'שיר חדש'), { log: console });
    } catch (error) {
      log('EXT7_SAVE_FAILED', { id: uuid, message: String(error?.message || error).slice(0, 160) });
    }
    // 15.11 (owner): every song also goes to the אודיו folder for downloading:
    // the file exactly as made (no re-encoding) with all its details. Never
    // fails the song.
    let downloadCopy = null;
    try { downloadCopy = await saveSongDownloadCopy(generated.audio, spec, uuid, tempDir); }
    catch (error) { log('DOWNLOAD_COPY_FAILED', { id: uuid, message: String(error?.message || error).slice(0, 160) }); }
    // 15.11 (owner): and to the "שירי AI" folder, best quality, all details.
    let aiFolder = null;
    try { aiFolder = await saveSongToAiFolder(generated.audio, spec, uuid, tempDir, { request: record.prompt || job.prompt || '', engine: generated.model || generated.provider || '' }); }
    catch (error) { log('AI_FOLDER_FAILED', { id: uuid, message: String(error?.message || error).slice(0, 160) }); }
    record.status = 'ready';
    record.audio_url = archived || ('yemot://' + playbackPaths.join(','));
    record.completed_at = new Date().toISOString();
    await saveSongRecord(record, 'PATCH');
    job.status = 'ready';
    log('SONG_READY', { id: uuid, provider: record.provider, durationSeconds: spec.durationSeconds, chunks: playbackPaths.length, ext7: ext7?.file || null, download: downloadCopy?.remote || null, aiFolder: aiFolder?.remote || null });
    return { id: uuid, spec, provider: record.provider, model: record.model, playbackPaths, ext7, record };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function newRecord(uuid, spec, job) {
  return {
    id: uuid, call_id: job.callId || null, user_id: null, prompt: job.prompt || '',
    title: spec.title, lyrics: spec.lyrics, genre: spec.genre, mood: spec.mood,
    duration_seconds: spec.durationSeconds, provider: null, model: null,
    status: 'generating_music', audio_url: null, error_message: null,
    created_at: new Date().toISOString(), completed_at: null
  };
}

async function buildAndUpload(spec, job) {
  const uuid = randomUUID();
  const record = newRecord(uuid, spec, job);
  log('LYRICS_READY', { id: uuid, chars: spec.lyrics.length });
  await saveSongRecord(record);
  try {
    job.status = 'generating_music';
    job.songId = uuid;
    job.onStatus?.({ status: 'generating_music', songId: uuid, title: spec.title, durationSeconds: spec.durationSeconds });
    log('MUSIC_GENERATION_STARTED', { id: uuid, durationSeconds: spec.durationSeconds });
    const generated = await generateAudio(spec, { jobId: uuid, callId: job.callId, caller: job.userKey, title: spec.title });
    log('MUSIC_GENERATION_READY', { id: uuid, provider: generated.provider, bytes: generated.audio.length });
    return await deliverSong(spec, generated, job, record, uuid);
  } catch (error) {
    record.status = 'failed';
    record.error_message = String(error?.message || error).slice(0, 300);
    record.completed_at = new Date().toISOString();
    await saveSongRecord(record, 'PATCH');
    job.status = 'failed';
    log('SONG_FAILED', { id: uuid, status: httpStatus(error) || 'unknown', message: record.error_message });
    throw error;
  }
}

// A song from the cloud worker that nobody waits for any more (the caller
// hung up and this service restarted meanwhile): still deliver it, so it is
// saved in extensions 4 and 7.
onOrphanSong(async (generated, payload, jobId) => {
  const spec = {
    title: String(payload?.title || 'שיר חדש'), lyrics: String(payload?.lyrics || ''), genre: '', mood: '',
    durationSeconds: Number(payload?.duration) || 0, musicPrompt: String(payload?.prompt || ''), language: String(payload?.language || 'he')
  };
  const id = /^[0-9a-f-]{36}$/.test(String(jobId)) ? String(jobId) : randomUUID();
  log('ORPHAN_SONG_DELIVERY', { id, title: spec.title });
  await deliverSong(spec, generated, { callId: payload?.callId || '', status: 'orphan' }, newRecord(id, spec, { callId: payload?.callId || '' }), id);
});

// Owner, 15.11: no limit on how many songs he asks for. SONG_MAX_PER_HOUR
// (a number) brings a per-caller hourly limit back if ever needed.
function enforceRateLimit(userKey) {
  if (!Number(process.env.SONG_MAX_PER_HOUR)) return;
  const key = String(userKey || 'unknown').slice(0, 100);
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const max = Math.max(1, Number(process.env.SONG_MAX_PER_HOUR));
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (bucket.count >= max) throw Object.assign(new Error('Song generation hourly limit reached'), { code: 'RATE_LIMITED' });
  bucket.count++;
}

function pumpQueue() {
  while (activeCount < MAX_CONCURRENT_JOBS && queue.length) {
    const item = queue.shift();
    activeCount++;
    item.run().then(item.resolve, item.reject).finally(() => {
      activeCount--;
      pumpQueue();
    });
  }
}

function enqueueJob(run) {
  if (activeCount >= MAX_CONCURRENT_JOBS && queue.length >= MAX_QUEUE_SIZE) {
    throw Object.assign(new Error('Song generation queue is full'), { status: 503, code: 'QUEUE_FULL' });
  }
  const promise = new Promise((resolve, reject) => queue.push({ run, resolve, reject }));
  pumpQueue();
  return promise;
}

export async function createSong({ prompt, callId = '', userKey = 'unknown', generateText, onStatus = () => {} }) {
  const request = normalizeSongRequest({ prompt });
  if (!request.prompt) throw Object.assign(new Error('Empty song prompt'), { code: 'NEEDS_CLARIFICATION' });
  if (activeJobs.has(callId) && callId) return activeJobs.get(callId);
  const job = { id: randomUUID(), callId: String(callId || ''), userKey: String(userKey || ''), prompt: request.prompt, status: 'queued', onStatus };
  log('SONG_REQUEST', { jobId: job.id, promptChars: request.prompt.length, durationSeconds: request.durationSeconds });
  onStatus({ status: 'queued', jobId: job.id });
  const promise = enqueueJob(async () => {
    try {
      job.status = 'generating_lyrics';
      log('LYRICS_STARTED', { jobId: job.id });
      onStatus({ status: 'generating_lyrics', jobId: job.id });
      // Owner, 23.11: longer songs (up to 4 minutes) mean longer lyrics; the
      // writer gets enough time, and one more try if its answer was unusable.
      const LLM_MS = Math.max(30000, Math.min(150000, Number(process.env.SONG_LLM_TIMEOUT_MS || 70000)));
      let spec, lastError;
      for (let attempt = 1; attempt <= 2 && !spec; attempt++) {
        let llmTimer;
        try {
          spec = await Promise.race([
            generateSongSpec(request, generateText),
            new Promise((_, reject) => { llmTimer = setTimeout(() => reject(Object.assign(new Error('Song LLM timed out'), { status: 408 })), LLM_MS); })
          ]);
        } catch (e) {
          lastError = e;
          if (e?.code === 'NEEDS_CLARIFICATION') throw e;
          log('LYRICS_FAILED', { jobId: job.id, attempt, message: String(e?.message || e).slice(0, 160) });
          noteSongEvent('lyrics_failed', { attempt, message: String(e?.message || e).slice(0, 160) });
        } finally { clearTimeout(llmTimer); }
      }
      if (!spec) throw lastError || new Error('Song lyrics failed');
      if (spec.needsClarification) {
        job.status = 'needs_clarification';
        return { needsClarification: true, clarificationQuestion: spec.clarificationQuestion, jobId: job.id };
      }
      enforceRateLimit(userKey);
      return await buildAndUpload(spec, job);
    } finally {
      activeJobs.delete(callId);
    }
  });
  if (callId) activeJobs.set(callId, promise);
  return promise;
}

export { cloudJobStatus } from './song-cloud.js';

export function getSongProviderHealth() {
  return {
    aceMusic: statusOf('acemusic'),
    aceStep: statusOf('ace-step'),
    githubCpu: statusOf('github-cpu'),
    huggingFaceSpace: statusOf('huggingface-space'),
    backup: statusOf('backup'),
    activeJobs: activeCount,
    recent: recentSongEvents(),
    queuedJobs: queue.length
  };
}
