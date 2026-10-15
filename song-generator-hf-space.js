import { Buffer } from 'node:buffer';

const DEFAULT_SPACE_URL = 'https://ace-step-ace-step-v1-5.hf.space';
const MAX_AUDIO_BYTES = 35 * 1024 * 1024;

function audioType(value) {
  const type = String(value || '').toLowerCase().split(';')[0].trim();
  return type.startsWith('audio/') || ['application/octet-stream', 'binary/octet-stream'].includes(type);
}

function authHeaders(json = false) {
  const token = String(process.env.HF_TOKEN || '').trim();
  return {
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(json ? { 'content-type': 'application/json' } : {})
  };
}

async function request(url, options, timeoutMs, label) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw Object.assign(new Error(label + ' network/timeout failure'), {
      status: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 408 : 502
    });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw Object.assign(new Error(label + ' HTTP ' + response.status + ': ' + body.slice(0, 180)), {
      status: response.status
    });
  }
  return response;
}

function parameterName(parameter) {
  return String(parameter?.parameter_name || parameter?.name || parameter?.label || '').toLowerCase();
}

function valueFor(parameter, spec) {
  const name = parameterName(parameter);
  if (name.includes('caption') || name === 'prompt' || name.includes('music_prompt')) return spec.musicPrompt || '';
  if (name.includes('lyrics')) return spec.lyrics || '';
  if (name.includes('vocal_language') || name === 'language') return spec.language || 'he';
  if (name.includes('audio_duration') || name === 'duration') return Math.max(30, Math.min(60, Number(spec.durationSeconds) || 45));
  if (name.includes('task_type')) return 'text2music';
  if (name.includes('audio_format')) return 'mp3';
  if (name.includes('inference_steps')) return 8;
  if (name.includes('batch_size')) return 1;
  if (name.includes('random_seed_checkbox') || name.includes('use_random_seed')) return true;
  if (name === 'seed') return -1;
  if (name === 'bpm') return 0;
  if (name.includes('key_scale') || name.includes('time_signature')) return 'NO USER INPUT';
  if (name.includes('guidance_scale')) return 1;
  if (name.includes('reference_audio') || name === 'src_audio') return null;
  if (name.includes('audio_code')) return '';
  if (name.includes('repainting_start')) return 0;
  if (name.includes('repainting_end')) return -1;
  if (name.includes('instruction_display')) return 'Fill the audio semantic mask based on the given conditions:';
  if (name.includes('audio_cover_strength')) return 1;
  if (name.includes('use_adg')) return false;
  if (name.includes('cfg_interval_start')) return 0;
  if (name.includes('cfg_interval_end')) return 1;
  if (name.includes('lm_temperature')) return 0.85;
  if (parameter && Object.prototype.hasOwnProperty.call(parameter, 'parameter_default')) {
    return parameter.parameter_default;
  }
  if (parameter && Object.prototype.hasOwnProperty.call(parameter, 'default')) return parameter.default;
  return null;
}

function chooseEndpoint(info) {
  const endpoints = info?.named_endpoints;
  if (!endpoints || typeof endpoints !== 'object') {
    throw Object.assign(new Error('ACE-Step Space did not expose named Gradio API endpoints'), { status: 502 });
  }
  const candidates = Object.entries(endpoints).filter(([, schema]) => {
    const params = Array.isArray(schema?.parameters) ? schema.parameters.map(parameterName) : [];
    return params.some(name => name.includes('caption')) && params.some(name => name.includes('lyrics'));
  });
  if (!candidates.length) {
    throw Object.assign(new Error('ACE-Step Space API schema has no endpoint accepting both caption and lyrics'), { status: 502 });
  }
  const preferred = candidates.find(([name]) => /generate_with_progress|generate_music/i.test(name));
  const [name, schema] = preferred || candidates[0];
  return { name: name.startsWith('/') ? name : '/' + name, schema };
}

function findAudioFile(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAudioFile(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const url = typeof value.url === 'string' ? value.url : '';
    const path = typeof value.path === 'string' ? value.path : '';
    if (url || path) return { url, path };
    for (const child of Object.values(value)) {
      const found = findAudioFile(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function parseCompletionEvent(body) {
  const lines = String(body || '').split(/\r?\n/);
  let event = '';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data = line.slice(5).trim();
    if (event === 'complete' && data) {
      try { return JSON.parse(data); } catch { /* continue to final event */ }
    }
  }
  throw Object.assign(new Error('ACE-Step Space did not return a completed generation event'), { status: 502 });
}

async function readLimited(response) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_AUDIO_BYTES) throw Object.assign(new Error('Generated audio exceeds size limit'), { status: 413 });
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw Object.assign(new Error('Generated audio is empty or too large'), { status: bytes.length ? 413 : 502 });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUDIO_BYTES) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('Generated audio exceeds size limit'), { status: 413 });
    }
    chunks.push(Buffer.from(value));
  }
  if (!total) throw Object.assign(new Error('ACE-Step Space returned empty audio'), { status: 502 });
  return Buffer.concat(chunks, total);
}

/**
 * Calls the public ACE-Step Gradio Space via its documented queue API.
 * This is intended for a quota-limited test/fallback, not guaranteed production SLA.
 */
export async function generateWithHuggingFaceSpace(spec) {
  const rawBase = String(process.env.HF_MUSIC_SPACE_URL || DEFAULT_SPACE_URL).trim();
  const base = new URL(rawBase);
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('HF_MUSIC_SPACE_URL must be a valid HTTPS URL');
  }
  base.pathname = base.pathname.replace(/\/$/, '');
  const timeoutMs = Math.max(30000, Math.min(300000, Number(process.env.SONG_GENERATION_TIMEOUT_MS || 180000)));
  const infoUrl = new URL('/gradio_api/info', base);
  const infoResponse = await request(infoUrl, { headers: authHeaders() }, Math.min(timeoutMs, 15000), 'ACE-Step Space schema');
  const info = await infoResponse.json();
  const { name, schema } = chooseEndpoint(info);
  const parameters = Array.isArray(schema.parameters) ? schema.parameters : [];
  const data = parameters.map(parameter => valueFor(parameter, spec));
  if (!data.some((value, index) => parameterName(parameters[index]).includes('caption') && value) ||
      !data.some((value, index) => parameterName(parameters[index]).includes('lyrics') && value)) {
    throw Object.assign(new Error('ACE-Step Space API schema did not accept the requested caption and lyrics'), { status: 502 });
  }

  const endpointPath = name.replace(/^\//, '');
  const submitUrl = new URL('/gradio_api/call/' + endpointPath, base);
  const submitted = await request(submitUrl, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ data })
  }, Math.min(timeoutMs, 30000), 'ACE-Step Space submission');
  const submission = await submitted.json();
  const eventId = String(submission?.event_id || '').trim();
  if (!eventId) throw Object.assign(new Error('ACE-Step Space did not return an event ID'), { status: 502 });

  const resultUrl = new URL('/gradio_api/call/' + endpointPath + '/' + encodeURIComponent(eventId), base);
  const resultResponse = await request(resultUrl, { headers: authHeaders() }, timeoutMs, 'ACE-Step Space generation');
  const outputs = parseCompletionEvent(await resultResponse.text());
  if (Array.isArray(outputs) && outputs[0] && typeof outputs[0] === 'object' && outputs[0].error) {
    throw Object.assign(new Error('ACE-Step Space generation failed'), { status: 502 });
  }
  const file = findAudioFile(outputs);
  if (!file) throw Object.assign(new Error('ACE-Step Space completed without an audio file'), { status: 502 });
  let audioUrl;
  if (file.url) audioUrl = new URL(file.url, base);
  else if (file.path) audioUrl = new URL('/gradio_api/file=' + file.path.replace(/^\//, ''), base);
  else throw Object.assign(new Error('ACE-Step Space returned an invalid audio reference'), { status: 502 });
  if (audioUrl.origin !== base.origin || !/\/(gradio_api\/file=|file=)/.test(audioUrl.pathname)) {
    throw new Error('ACE-Step Space returned an unexpected audio URL');
  }

  const audioResponse = await request(audioUrl, { headers: authHeaders() }, Math.min(timeoutMs, 30000), 'ACE-Step Space audio download');
  const contentType = String(audioResponse.headers.get('content-type') || '').toLowerCase();
  if (!audioType(contentType)) throw Object.assign(new Error('ACE-Step Space returned a non-audio file'), { status: 502 });
  const audio = await readLimited(audioResponse);
  return {
    audio,
    provider: 'huggingface-space',
    model: String(process.env.ACESTEP_MODEL || 'acestep-v15-turbo'),
    contentType
  };
}
