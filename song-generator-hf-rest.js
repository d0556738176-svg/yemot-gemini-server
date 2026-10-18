import { Buffer } from 'node:buffer';

const MAX_AUDIO_BYTES = 35 * 1024 * 1024;

function headers(json = false) {
  const token = String(process.env.HF_TOKEN || '').trim();
  return {
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(json ? { 'content-type': 'application/json' } : {})
  };
}

function fail(message, status = 502, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

async function request(url, options, timeoutMs, label) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw fail(label + ' network/timeout failure', error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 408 : 502);
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    throw fail(label + ' HTTP ' + response.status + (body ? ': ' + body.slice(0, 180) : ''), response.status);
  }
  return response;
}

async function jsonResponse(response, label) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    const html = /^\s*<!doctype html|^\s*<html/i.test(body);
    throw fail(label + ' returned ' + (html ? 'an HTML page instead of JSON' : 'invalid JSON'), 404, { apiUnavailable: true });
  }
}

function unwrap(value) {
  if (value && typeof value === 'object' && value.data && typeof value.data === 'object') {
    return { ...value.data, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'data')) };
  }
  return value && typeof value === 'object' ? value : {};
}

function findAudioPath(value, depth = 0) {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) || /(?:\/v1\/audio|audio_path|first_audio_path)/i.test(value)) return value;
    return '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAudioPath(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of ['first_audio_path', 'audio_url', 'audio_path', 'url', 'file', 'path']) {
      const item = value[key];
      if (typeof item === 'string' && item.trim()) return item.trim();
    }
    for (const item of Object.values(value)) {
      const found = findAudioPath(item, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

async function readAudio(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_AUDIO_BYTES) throw fail('ACE-Step REST audio exceeds size limit', 413);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw fail('ACE-Step REST audio is empty or too large', bytes.length ? 413 : 502);
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (!(type.startsWith('audio/') || type.includes('octet-stream'))) {
    throw fail('ACE-Step REST returned a non-audio response', 502);
  }
  return { audio: bytes, contentType: type };
}

/**
 * Uses the current ACE-Step 1.5 REST API (/v1/music/generate + /v1/jobs/{id}).
 * If the public Space does not expose these endpoints, the caller may try the
 * older Gradio queue API. Generation failures and quota errors are not retried.
 */
export async function generateWithAceStepRest(spec) {
  const token = String(process.env.HF_TOKEN || '').trim();
  if (!token) throw fail('HF_TOKEN is required for ACE-Step Space generation', 503);
  const base = new URL(String(process.env.HF_MUSIC_SPACE_URL || 'https://ace-step-ace-step-v1-5.hf.space').trim());
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('ACE-Step REST base URL must be HTTPS');
  base.pathname = base.pathname.replace(/\/$/, '');
  const timeoutMs = Math.max(30000, Math.min(600000, Number(process.env.SONG_GENERATION_TIMEOUT_MS || 300000)));
  const started = Date.now();

  const submittedResponse = await request(new URL('/v1/music/generate', base), {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({
      caption: String(spec.musicPrompt || ''),
      lyrics: String(spec.lyrics || ''),
      vocal_language: String(spec.language || 'he'),
      audio_format: 'mp3',
      audio_duration: Math.max(30, Math.min(240, Number(spec.durationSeconds) || 180)),
      inference_steps: 8,
      batch_size: 1,
      use_random_seed: true,
      thinking: true
    })
  }, Math.min(timeoutMs, 30000), 'ACE-Step REST submission');

  const submitted = unwrap(await jsonResponse(submittedResponse, 'ACE-Step REST submission'));
  const jobId = String(submitted.job_id || submitted.jobId || submitted.task_id || '').trim();
  if (!jobId) throw fail('ACE-Step REST returned no job ID', 502);

  let finalJob = null;
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 2500));
    const response = await request(new URL('/v1/jobs/' + encodeURIComponent(jobId), base), {
      headers: headers()
    }, Math.min(timeoutMs, 20000), 'ACE-Step REST job status');
    finalJob = unwrap(await jsonResponse(response, 'ACE-Step REST job status'));
    const status = String(finalJob.status || '').toLowerCase();
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status) || Number(finalJob.status) === 2) {
      const detail = String(finalJob.error || finalJob.message || finalJob.detail || 'remote generation failed').slice(0, 250);
      throw fail('ACE-Step REST generation failed: ' + detail, 502);
    }
    if (['succeeded', 'success', 'completed', 'complete'].includes(status) || Number(finalJob.status) === 1) break;
  }
  if (!finalJob || !(['succeeded', 'success', 'completed', 'complete'].includes(String(finalJob.status || '').toLowerCase()) || Number(finalJob.status) === 1)) {
    throw fail('ACE-Step REST generation timed out', 408);
  }

  const audioPath = findAudioPath(finalJob.result || finalJob);
  if (!audioPath) throw fail('ACE-Step REST job succeeded without an audio path', 502);
  let audioUrl;
  if (/^https?:\/\//i.test(audioPath)) audioUrl = new URL(audioPath);
  else if (audioPath.startsWith('/v1/audio')) audioUrl = new URL(audioPath, base);
  else audioUrl = new URL('/v1/audio?path=' + encodeURIComponent(audioPath), base);
  if (audioUrl.protocol !== 'https:' || audioUrl.origin !== base.origin || !audioUrl.pathname.includes('/v1/audio')) {
    throw new Error('ACE-Step REST returned an unexpected audio URL; refusing to forward credentials');
  }
  const audioResponse = await request(audioUrl, { headers: headers() }, Math.min(timeoutMs, 30000), 'ACE-Step REST audio download');
  const { audio, contentType } = await readAudio(audioResponse);
  return { audio, provider: 'huggingface-space-rest', model: String(finalJob.result?.model || process.env.ACESTEP_MODEL || 'ACE-Step 1.5'), contentType };
}
