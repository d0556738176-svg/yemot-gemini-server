// fal.ai ACE-Step adapter for branch 4.
// Pay-per-use host for the same ACE-Step model, reached over a simple HTTP
// API (no Space to wake, no ZeroGPU token). Endpoint and schema verified
// against fal's published model API (fal.run/fal-ai/ace-step).
const FAL_ENDPOINT = 'https://fal.run/fal-ai/ace-step';
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

export function isFalConfigured(env = process.env) {
  return !!String(env.FAL_KEY || '').trim();
}

// spec: { lyrics, musicPrompt, language, durationSeconds }
export async function generateWithFalAceStep(spec, env = process.env) {
  const key = String(env.FAL_KEY || '').trim();
  if (!key) throw Object.assign(new Error('FAL_KEY is not configured'), { status: 503 });

  const tags = String(spec.musicPrompt || '').trim() || 'calm acoustic song, gentle vocal';
  const lyrics = String(spec.lyrics || '').trim();
  const duration = Math.max(5, Math.min(240, Number(spec.durationSeconds) || 60));
  const timeoutMs = Math.max(30000, Math.min(600000, Number(env.SONG_GENERATION_TIMEOUT_MS || 180000)));

  const response = await fetch(FAL_ENDPOINT, {
    method: 'POST',
    headers: { authorization: 'Key ' + key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ tags, lyrics: lyrics || '[inst]', duration }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  if (!response.ok) {
    const detail = body?.detail || body?.error || text.slice(0, 200);
    throw Object.assign(new Error('fal ACE-Step HTTP ' + response.status + ': ' + String(detail).slice(0, 200)), { status: response.status });
  }
  const audioUrl = body?.audio?.url;
  if (!audioUrl || typeof audioUrl !== 'string') {
    throw Object.assign(new Error('fal ACE-Step returned no audio URL'), { status: 502 });
  }
  const parsed = new URL(audioUrl);
  if (parsed.protocol !== 'https:') throw new Error('fal ACE-Step returned a non-HTTPS audio URL');

  const audioResponse = await fetch(parsed, { signal: AbortSignal.timeout(Math.min(timeoutMs, 60000)) });
  if (!audioResponse.ok || !audioResponse.body) throw Object.assign(new Error('fal audio download HTTP ' + audioResponse.status), { status: 502 });
  const contentType = String(audioResponse.headers.get('content-type') || '').toLowerCase();

  const reader = audioResponse.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUDIO_BYTES) throw Object.assign(new Error('fal audio exceeds size limit'), { status: 502 });
    chunks.push(Buffer.from(value));
  }
  const audio = Buffer.concat(chunks, total);
  if (!audio.length) throw Object.assign(new Error('fal audio is empty'), { status: 502 });

  return { audio, provider: 'fal-ace-step', model: 'fal-ai/ace-step', contentType: contentType || 'audio/mpeg', seed: body?.seed ?? null };
}
