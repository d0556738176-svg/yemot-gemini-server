import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

const ELEVEN_URL = 'https://api.elevenlabs.io/v1/music';
const YEMOT_API_BASE = 'https://www.call2all.co.il/ym/api';
const MAX_AUDIO_BYTES = 35 * 1024 * 1024;
const DEFAULT_DURATION_SECONDS = 45;
const MAX_DURATION_SECONDS = 60;
const JOB_TIMEOUT_MS = Number(process.env.SONG_GENERATION_TIMEOUT_MS || 120000);
const activeJobs = new Map();
const providerHealth = new Map();
const rateBuckets = new Map();
const queue = [];
let activeCount = 0;
const MAX_CONCURRENT_JOBS = Math.max(1, Math.min(3, Number(process.env.SONG_MAX_CONCURRENT || 2)));
const MAX_QUEUE_SIZE = Math.max(0, Math.min(10, Number(process.env.SONG_MAX_QUEUE || 4)));

function log(event, details = {}) {
  console.info('[SONG]', event, details);
}

function statusOf(provider) {
  const state = providerHealth.get(provider);
  if (!state) return { status: 'available', cooldownUntil: 0 };
  if (state.cooldownUntil > Date.now()) return { ...state, status: state.status };
  if (state.status !== 'disabled') providerHealth.set(provider, { status: 'available', cooldownUntil: 0 });
  return providerHealth.get(provider) || { status: 'available', cooldownUntil: 0 };
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
    '{"title":"...","language":"he","genre":"...","mood":"...","tempo":"...","duration_seconds":45,"lyrics":"...","music_prompt":"...","needs_clarification":false,"clarification_question":""}',
    'אם הבקשה אינה ברורה מספיק כדי ליצור שיר סביר, החזר needs_clarification=true ושאלה קצרה בשדה clarification_question.',
    'כתוב מילים מקוריות בלבד; אל תצטט שיר קיים ואל תבקש חיקוי מדויק של אמן מסוים.',
    'במילים השתמש בסימוני מבנה [Intro], [Verse 1], [Chorus], [Verse 2], [Outro] לפי הצורך.',
    'הגבל את אורך השיר ל-30 עד 60 שניות. ברירת המחדל היא ' + normalized.durationSeconds + ' שניות.',
    'genre, mood, tempo ו-music_prompt חייבים להיות באנגלית כדי שמנוע המוזיקה יבין אותם. שמור את מילות השיר בשפה שביקש המתקשר.',
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
    const m = line.match(heading);
    if (m) {
      if (current.lines.length || !sections.length) sections.push(current);
      current = { name: m[1].trim(), lines: [] };
    } else if (line.trim()) current.lines.push(line.trim().slice(0, 200));
  }
  if (current.lines.length || !sections.length) sections.push(current);
  const useful = sections.filter(x => x.lines.length).slice(0, 6);
  if (!useful.length) useful.push({ name: 'Song', lines: [String(lyrics).slice(0, 200)] });
  const totalMs = durationSeconds * 1000;
  const eachMs = Math.floor(totalMs / useful.length / 1000) * 1000;
  let remaining = totalMs;
  return useful.map((section, index) => {
    const duration = index === useful.length - 1 ? remaining : eachMs;
    remaining -= duration;
    const text = '[' + section.name + ']\n' + section.lines.join('\n');
    return {
      text: text.slice(0, 6100),
      duration_ms: Math.max(3000, duration),
      positive_styles: [spec.musicPrompt, spec.tempo, 'original song', 'clear vocals'].filter(Boolean).map(x => String(x).slice(0, 180)).slice(0, 10),
      negative_styles: ['unintelligible vocals', 'abrupt ending'],
      context_adherence: 'high'
    };
  });
}

export function buildCompositionPlan(spec) {
  return {
    chunks: splitLyrics(spec.lyrics, spec.durationSeconds, spec)
  };
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

async function generateWithEleven(spec) {
  const key = String(process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error('Eleven Music is not configured'), { status: 503, provider: 'eleven' });
  const url = new URL(ELEVEN_URL);
  url.searchParams.set('output_format', 'mp3_48000_192');
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      model_id: 'music_v2_5',
      composition_plan: buildCompositionPlan(spec)
    })
  }, Math.min(JOB_TIMEOUT_MS, 90000), 'Eleven Music');
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new Error('Eleven Music returned an empty or oversized audio file');
  return { audio, provider: 'eleven', model: 'music_v2_5', contentType: 'audio/mpeg' };
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
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new Error('Backup provider returned an empty or oversized audio file');
  return { audio, provider: 'backup', model: String(process.env.MUSIC_BACKUP_MODEL || 'configured-provider'), contentType: type || 'application/octet-stream' };
}

async function generateAudio(spec) {
  const elevenState = statusOf('eleven');
  if (elevenState.status !== 'disabled' && elevenState.cooldownUntil <= Date.now()) {
    try {
      log('MUSIC_PROVIDER_SELECTED', { provider: 'eleven', model: 'music_v2_5' });
      const result = await generateWithEleven(spec);
      markProvider('eleven', 'available');
      return result;
    } catch (error) {
      const status = httpStatus(error);
      const limited = status === 429;
      const temporary = status === 408 || status === 500 || status === 502 || status === 503 || status === 504;
      markProvider('eleven', limited ? 'rate_limited' : temporary ? 'temporary_error' : 'disabled',
        limited ? 60000 : temporary ? 15000 : 0);
      log('MUSIC_PROVIDER_FAILED', { provider: 'eleven', status: status || 'unknown' });
      // Authentication, missing-endpoint, and provider availability failures should still try the configured backup.
      // Only clearly invalid generation requests should fail fast without a backup attempt.
      if (!shouldFallbackToBackup(status)) throw error;
    }
  }
  const backupEndpoint = String(process.env.MUSIC_BACKUP_API_URL || '').trim();
  const backupKey = String(process.env.MUSIC_BACKUP_API_KEY || '').trim();
  if (backupEndpoint && backupKey) {
    try {
      log('MUSIC_PROVIDER_SELECTED', { provider: 'backup' });
      const result = await generateWithBackup(spec);
      markProvider('backup', 'available');
      return result;
    } catch (error) {
      const status = httpStatus(error);
      markProvider('backup', status === 429 ? 'rate_limited' : 'temporary_error', status === 429 ? 60000 : 15000);
      log('MUSIC_PROVIDER_FAILED', { provider: 'backup', status: status || 'unknown' });
      throw error;
    }
  }
  throw Object.assign(new Error('Music generation unavailable and no backup provider is configured'), { status: 503 });
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

async function convertToYemotWavChunks(audio, tempDir) {
  const mp3Path = path.join(tempDir, 'source.mp3');
  const chunksDir = path.join(tempDir, 'chunks');
  await fs.mkdir(chunksDir, { recursive: true });
  await fs.writeFile(mp3Path, audio);
  const pattern = path.join(chunksDir, 'song-%03d.wav');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y', '-i', mp3Path,
    '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le',
    '-f', 'segment', '-segment_time', '120', '-reset_timestamps', '1', pattern
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
  const key = String(process.env.YEMOT_API_KEY || '').trim();
  if (!key) throw new Error('YEMOT_API_KEY is not configured');
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

async function buildAndUpload(spec, job) {
  const uuid = randomUUID();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'song-generator-'));
  const record = {
    id: uuid, call_id: job.callId || null, user_id: null, prompt: job.prompt,
    title: spec.title, lyrics: spec.lyrics, genre: spec.genre, mood: spec.mood,
    duration_seconds: spec.durationSeconds, provider: null, model: null,
    status: 'generating_music', audio_url: null, error_message: null,
    created_at: new Date().toISOString(), completed_at: null
  };
  log('LYRICS_READY', { id: uuid, chars: spec.lyrics.length });
  await saveSongRecord(record);
  try {
    job.status = 'generating_music';
    log('MUSIC_GENERATION_STARTED', { id: uuid, durationSeconds: spec.durationSeconds });
    const generated = await generateAudio(spec);
    log('MUSIC_GENERATION_READY', { id: uuid, provider: generated.provider, bytes: generated.audio.length });
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
    record.status = 'ready';
    record.audio_url = archived || ('yemot://' + playbackPaths.join(','));
    record.completed_at = new Date().toISOString();
    await saveSongRecord(record, 'PATCH');
    job.status = 'ready';
    log('SONG_READY', { id: uuid, provider: record.provider, durationSeconds: spec.durationSeconds, chunks: playbackPaths.length });
    return { id: uuid, spec, provider: record.provider, model: record.model, playbackPaths, record };
  } catch (error) {
    record.status = 'failed';
    record.error_message = String(error?.message || error).slice(0, 300);
    record.completed_at = new Date().toISOString();
    await saveSongRecord(record, 'PATCH');
    job.status = 'failed';
    log('SONG_FAILED', { id: uuid, status: httpStatus(error) || 'unknown', message: record.error_message });
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function enforceRateLimit(userKey) {
  const key = String(userKey || 'unknown').slice(0, 100);
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const max = Math.max(1, Math.min(5, Number(process.env.SONG_MAX_PER_HOUR || 2)));
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
  const job = { id: randomUUID(), callId: String(callId || ''), prompt: request.prompt, status: 'queued' };
  log('SONG_REQUEST', { jobId: job.id, promptChars: request.prompt.length, durationSeconds: request.durationSeconds });
  onStatus({ status: 'queued', jobId: job.id });
  const promise = enqueueJob(async () => {
    try {
      job.status = 'generating_lyrics';
      log('LYRICS_STARTED', { jobId: job.id });
      onStatus({ status: 'generating_lyrics', jobId: job.id });
      let llmTimer;
      let spec;
      try {
        spec = await Promise.race([
          generateSongSpec(request, generateText),
          new Promise((_, reject) => { llmTimer = setTimeout(() => reject(Object.assign(new Error('Song LLM timed out'), { status: 408 })), 30000); })
        ]);
      } finally { clearTimeout(llmTimer); }
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

export function getSongProviderHealth() {
  return {
    eleven: statusOf('eleven'),
    backup: statusOf('backup'),
    activeJobs: activeCount,
    queuedJobs: queue.length
  };
}
