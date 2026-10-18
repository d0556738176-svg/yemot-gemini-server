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
  // Match ACE-Step v1.5 Gradio defaults for fields not specified by the caller.
  if (name.includes('audio_duration') || name === 'duration') return Math.max(30, Math.min(240, Number(spec.durationSeconds) || 180));
  if (name.includes('task_type')) return 'text2music';
  if (name.includes('audio_format')) return 'mp3';
  if (name.includes('inference_steps')) return 8;
  if (name.includes('batch_size')) return 1;
  if (name.includes('random_seed_checkbox') || name.includes('use_random_seed')) return true;
  if (name === 'seed') return '-1';
  if (name === 'bpm') return null;
  if (name.includes('key_scale')) return '';
  if (name.includes('time_signature')) return '';
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
  if (name === 'shift') return 3;
  if (name === 'infer_method') return 'ode';
  if (name === 'custom_timesteps') return '';
  if (name === 'think_checkbox') return true;
  if (name === 'lm_cfg_scale') return 2;
  if (name === 'lm_top_k') return 0;
  if (name === 'lm_top_p') return 0.9;
  if (name === 'lm_negative_prompt') return 'NO USER INPUT';
  if (name === 'use_cot_metas' || name === 'use_cot_caption' || name === 'use_cot_language') return true;
  if (name === 'is_format_caption') return false;
  if (name === 'constrained_decoding_debug') return false;
  if (name === 'allow_lm_batch') return true;
  if (name === 'auto_score' || name === 'auto_lrc') return false;
  if (name === 'score_scale') return 0.5;
  if (name === 'lm_batch_chunk_size') return 8;
  if (name === 'instrumental_checkbox') return false;
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
  // Current official Space exposes generation_wrapper with generic names for
  // many positional inputs because its Python signature uses *args.
  const generationEntry = Object.entries(endpoints).find(([name]) => /(^|\/)generation_wrapper$/.test(name));
  if (generationEntry) {
    const [name, schema] = generationEntry;
    return { name: name.startsWith('/') ? name : '/' + name, schema, positional: true };
  }
  // Older builds may expose the generation function directly. Never select a
  // caption/lyrics formatting endpoint as a substitute for audio generation.
  const candidates = Object.entries(endpoints).filter(([name, schema]) => {
    if (!/generate_with_progress|generate_with_batch_management|generate_music/i.test(name)) return false;
    const params = Array.isArray(schema?.parameters) ? schema.parameters.map(parameterName) : [];
    return params.some(value => value.includes('caption')) && params.some(value => value.includes('lyrics'));
  });
  if (!candidates.length) {
    throw Object.assign(new Error('ACE-Step Space API schema does not expose a supported music-generation endpoint'), { status: 502 });
  }
  const [name, schema] = candidates[0];
  return { name: name.startsWith('/') ? name : '/' + name, schema, positional: false };
}

function defaultParameterValue(parameter) {
  if (parameter && Object.prototype.hasOwnProperty.call(parameter, 'parameter_default')) return parameter.parameter_default;
  if (parameter && Object.prototype.hasOwnProperty.call(parameter, 'default')) return parameter.default;
  return null;
}

function generationWrapperData(parameters, spec) {
  // Verified against the current official Space schema: the generation_wrapper
  // has 49 positional inputs; caption/lyrics and most settings are named param_N.
  if (parameters.length !== 49) {
    throw Object.assign(new Error('Unsupported ACE-Step generation_wrapper schema length: ' + parameters.length), { status: 502 });
  }
  const data = parameters.map(defaultParameterValue);
  // Use the Space's currently advertised model value. Hard-coding the older
  // 'acestep-v15-turbo' name caused the live generation call to fail because
  // the current Space advertises 'acestep-v15-xl-turbo' as its selected model.
  data[0] = String(defaultParameterValue(parameters[0]) || 'acestep-v15-xl-turbo');
  data[1] = 'custom'; // generation_mode
  data[4] = String(spec.musicPrompt || ''); // captions
  data[5] = String(spec.lyrics || '');
  data[9] = String(spec.language || 'he'); // vocal_language
  data[15] = Math.max(30, Math.min(240, Number(spec.durationSeconds) || 180)); // audio_duration
  data[16] = 1; // one audio per request to conserve shared GPU quota
  data[23] = 'text2music'; // task_type
  data[30] = 'mp3'; // audio_format (shift, inference method, and custom timesteps precede it)
  // Preserve all other live Space defaults. Generic param_N labels make it unsafe
  // to override later indices without an exact named signature.
  return data;
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
  const seenEvents = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      if (event && !seenEvents.includes(event)) seenEvents.push(event);
    } else if (line.startsWith('data:')) {
      data = line.slice(5).trim();
    }
    if (data && (event === 'complete' || event === 'error')) {
      if (event === 'error') {
        throw Object.assign(new Error('ACE-Step Space generation event error: ' + data.slice(0, 220)), { status: 502 });
      }
      try { return JSON.parse(data); } catch { /* try the final event if this data frame is not JSON */ }
    }
  }
  const excerpt = String(body || '').replace(/[\r\n]+/g, ' ').slice(0, 260);
  throw Object.assign(new Error('ACE-Step Space did not return a completed generation event; events=' + seenEvents.join(',') + '; response=' + excerpt), { status: 502 });
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
  if (!String(process.env.HF_TOKEN || '').trim()) {
    throw Object.assign(new Error('HF_TOKEN is required for ACE-Step ZeroGPU generation; anonymous requests are not reliable'), { status: 503 });
  }
  const rawBase = String(process.env.HF_MUSIC_SPACE_URL || DEFAULT_SPACE_URL).trim();
  const base = new URL(rawBase);
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('HF_MUSIC_SPACE_URL must be a valid HTTPS URL');
  }
  base.pathname = base.pathname.replace(/\/$/, '');
  const timeoutMs = Math.max(30000, Math.min(600000, Number(process.env.SONG_GENERATION_TIMEOUT_MS || 300000)));
  const infoUrl = new URL('/gradio_api/info', base);
  const infoResponse = await request(infoUrl, { headers: authHeaders() }, Math.min(timeoutMs, 15000), 'ACE-Step Space schema');
  const info = await infoResponse.json();
  const { name, schema, positional } = chooseEndpoint(info);
  const parameters = Array.isArray(schema.parameters) ? schema.parameters : [];
  const data = positional ? generationWrapperData(parameters, spec) : parameters.map(parameter => valueFor(parameter, spec));
  if (positional) {
    if (!data[4] || !data[5]) {
      throw Object.assign(new Error('ACE-Step Space generation schema did not accept the requested caption and lyrics'), { status: 502 });
    }
  } else if (!data.some((value, index) => parameterName(parameters[index]).includes('caption') && value) ||
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
  else if (file.path) audioUrl = new URL('/gradio_api/file=' + file.path, base);
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
