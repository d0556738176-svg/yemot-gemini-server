import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';

const BASE_URL = 'https://ace-step-ace-step-v1-5.hf.space';
const MAX_AUDIO_BYTES = 35 * 1024 * 1024;
const TOTAL_TIMEOUT_MS = 300000;
const POLL_INTERVAL_MS = 5000;

function authHeaders(json = false) {
  const token = String(process.env.HF_TOKEN || '').trim();
  return {
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(json ? { 'content-type': 'application/json' } : {})
  };
}

async function request(url, options = {}, timeoutMs = 20000, label = 'ACE-Step REST') {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(label + ' network/timeout: ' + (error?.name || 'Error'));
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).replace(/Bearer\\s+\\S+/gi, 'Bearer [redacted]');
    throw new Error(label + ' HTTP ' + response.status + ': ' + body.slice(0, 350));
  }
  return response;
}

function summarize(value) {
  if (!value || typeof value !== 'object') return { type: value === null ? 'null' : typeof value };
  return {
    keys: Object.keys(value).slice(0, 20),
    status: value.status,
    job_id: value.job_id ? '[present]' : undefined,
    error: value.error == null ? value.error : String(value.error).slice(0, 250),
    resultKeys: value.result && typeof value.result === 'object' ? Object.keys(value.result).slice(0, 20) : undefined
  };
}

async function downloadAudio(pathOrUrl, base) {
  const audioUrl = /^https?:\\/\\//i.test(pathOrUrl)
    ? new URL(pathOrUrl)
    : new URL('/v1/audio?path=' + encodeURIComponent(pathOrUrl), base);
  if (audioUrl.protocol !== 'https:' || audioUrl.origin !== base.origin) {
    throw new Error('ACE-Step returned an unexpected audio host; refusing to forward credentials');
  }
  const response = await request(audioUrl, { headers: authHeaders() }, 30000, 'ACE-Step audio download');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_AUDIO_BYTES) throw new Error('Generated audio exceeds size limit');
  const bytes = Buffer.from(await response.arrayBuffer());
  const validHeader = bytes.subarray(0, 3).toString('ascii') === 'ID3' ||
    (bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES || bytes.length < 10000 || !validHeader) {
    throw new Error('ACE-Step REST response was not a valid MP3 (bytes=' + bytes.length + ')');
  }
  return bytes;
}

if (!String(process.env.HF_TOKEN || '').trim()) {
  throw new Error('HF_TOKEN GitHub Secret is required for this isolated free-space test');
}

const base = new URL(BASE_URL);
const started = Date.now();
try {
  // Probe the documented REST API first; do not fall back to Gradio silently.
  const health = await request(new URL('/health', base), { headers: authHeaders() }, 15000, 'ACE-Step health');
  const healthData = await health.json();
  console.log('ACE_STEP_REST_HEALTH_OK', JSON.stringify(summarize(healthData)));

  const modelsResponse = await request(new URL('/v1/models', base), { headers: authHeaders() }, 15000, 'ACE-Step models');
  const modelsData = await modelsResponse.json();
  console.log('ACE_STEP_REST_MODELS_OK', JSON.stringify(summarize(modelsData)));

  const submitResponse = await request(new URL('/v1/music/generate', base), {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      model: 'acestep-v15-turbo',
      caption: 'Upbeat Israeli pop, modern synths, warm bass, punchy drums, clear solo vocal singing Hebrew lyrics',
      lyrics: '[Verse 1]\\nנוסעים קדימה, האור נדלק\\nקצב בלב וכל רגע מתחזק\\n[Chorus]\\nעוד צעד ועוד חלום\\nשרים ביחד עד סוף היום',
      vocal_language: 'he',
      audio_format: 'mp3',
      audio_duration: 30,
      inference_steps: 8,
      use_random_seed: true,
      thinking: true
    })
  }, 30000, 'ACE-Step REST generation submit');
  const submitted = await submitResponse.json();
  const jobId = String(submitted?.job_id || '').trim();
  console.log('ACE_STEP_REST_SUBMITTED', JSON.stringify({ ...summarize(submitted), job_id: jobId ? '[present]' : undefined }));
  if (!jobId) throw new Error('ACE-Step REST API returned no job_id');

  let finalJob;
  while (Date.now() - started < TOTAL_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    const poll = await request(new URL('/v1/jobs/' + encodeURIComponent(jobId), base), {
      headers: authHeaders()
    }, 15000, 'ACE-Step job poll');
    finalJob = await poll.json();
    console.log('ACE_STEP_REST_STATUS', JSON.stringify({
      status: finalJob?.status,
      queue_position: finalJob?.queue_position,
      eta_seconds: finalJob?.eta_seconds,
      error: finalJob?.error == null ? finalJob?.error : String(finalJob.error).slice(0, 200)
    }));
    if (finalJob?.status === 'failed') {
      throw new Error('ACE-Step generation failed: ' + String(finalJob?.error || 'no error details').slice(0, 350));
    }
    if (finalJob?.status === 'succeeded') break;
  }
  if (finalJob?.status !== 'succeeded') throw new Error('ACE-Step generation timed out after ' + TOTAL_TIMEOUT_MS + 'ms');

  const result = finalJob?.result || {};
  const audioPath = result.first_audio_path || result.audio_paths?.[0] || result.audio_url;
  if (!audioPath || typeof audioPath !== 'string') {
    throw new Error('ACE-Step job succeeded without an audio path; result=' + JSON.stringify(summarize(result)));
  }
  const bytes = await downloadAudio(audioPath, base);
  const outputPath = 'branch4-ace-step-rest-hebrew-test.mp3';
  await writeFile(outputPath, bytes);
  console.log('LIVE_ACE_STEP_REST_MUSIC_TEST_OK', JSON.stringify({
    provider: 'ace-step-huggingface-rest',
    model: result.model || 'acestep-v15-turbo',
    bytes: bytes.length,
    mp3HeaderValid: true,
    outputPath,
    elapsedMs: Date.now() - started,
    hebrewVocalQuality: 'requires human listening review'
  }));
} catch (error) {
  console.error('LIVE_ACE_STEP_REST_MUSIC_TEST_FAILED', String(error?.message || error).slice(0, 700));
  process.exitCode = 1;
}
