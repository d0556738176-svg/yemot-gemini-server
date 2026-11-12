// Extension 4 music engine: the official ACE-Step cloud (acemusic.ai), run by
// the model's own developers. Free API key, no card, no GPU to wake.
//
// Uses the OpenRouter-compatible endpoint documented in ACE-Step-1.5
// docs/en/Openrouter_API_DOC.md: one synchronous POST /v1/chat/completions
// returns the finished song inline as a base64 data URL.
//
// Env: ACE_MUSIC_API_KEY (required), ACE_MUSIC_API_URL (default
// https://api.acemusic.ai), ACE_MUSIC_MODEL (default acemusic/acestep-v15-turbo).

const DEFAULT_BASE = 'https://api.acemusic.ai';
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

export function isAceMusicConfigured(env = process.env) {
  return !!String(env.ACE_MUSIC_API_KEY || '').trim();
}

export function buildAceMusicPayload(spec, env = process.env) {
  const duration = Math.max(30, Math.min(240, Math.round(Number(spec.durationSeconds) || 60)));
  const prompt = String(spec.musicPrompt || [spec.genre, spec.mood, spec.tempo].filter(Boolean).join(', ') || 'song with clear lead vocals')
    .slice(0, 1800);
  return {
    model: String(env.ACE_MUSIC_MODEL || 'acemusic/acestep-v15-turbo'),
    // With `lyrics` set, the message text is used as the style caption.
    messages: [{ role: 'user', content: prompt }],
    lyrics: String(spec.lyrics || '').slice(0, 8000),
    thinking: true,
    stream: false,
    audio_config: {
      duration,
      vocal_language: String(spec.language || 'he').slice(0, 12),
      instrumental: false,
      format: 'mp3'
    }
  };
}

export function decodeAceMusicResponse(body) {
  const choice = body?.choices?.[0];
  if (!choice) throw Object.assign(new Error('acemusic returned no choices'), { status: 502 });
  if (choice.finish_reason === 'error') {
    throw Object.assign(new Error('acemusic generation error: ' + String(choice.message?.content || 'unknown').slice(0, 200)), { status: 502 });
  }
  const url = String(choice.message?.audio?.[0]?.audio_url?.url || '');
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) throw Object.assign(new Error('acemusic returned no audio'), { status: 502 });
  const audio = Buffer.from(match[2], 'base64');
  if (audio.length < 10000) throw Object.assign(new Error('acemusic audio is empty or too short'), { status: 502 });
  if (audio.length > MAX_AUDIO_BYTES) throw Object.assign(new Error('acemusic audio exceeded size limit'), { status: 413 });
  return { audio, contentType: match[1].toLowerCase() || 'audio/mpeg', info: String(choice.message?.content || '').slice(0, 600) };
}

export async function generateWithAceMusic(spec, env = process.env) {
  const key = String(env.ACE_MUSIC_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error('ACE_MUSIC_API_KEY is missing'), { status: 503 });
  const base = new URL(String(env.ACE_MUSIC_API_URL || DEFAULT_BASE).trim());
  if (base.protocol !== 'https:') throw new Error('ACE_MUSIC_API_URL must use HTTPS');
  const timeoutMs = Math.max(60000, Math.min(660000, Number(env.SONG_GENERATION_TIMEOUT_MS || 540000)));
  const payload = buildAceMusicPayload(spec, env);
  let response;
  try {
    response = await fetch(new URL('/v1/chat/completions', base), {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/json; charset=utf-8',
        // The official client identifies as curl; some edge filters reject
        // unknown default agents.
        'user-agent': 'curl/8.7.1'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw Object.assign(new Error('acemusic generation timed out'), { status: 408 });
    }
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = '';
    try { const j = JSON.parse(text); detail = j.detail || j.error?.message || j.message || ''; } catch {}
    throw Object.assign(new Error('acemusic HTTP ' + response.status + (detail ? ': ' + String(detail).slice(0, 200) : '')), { status: response.status });
  }
  let body;
  try { body = JSON.parse(text); }
  catch { throw Object.assign(new Error('acemusic returned invalid JSON'), { status: 502 }); }
  const decoded = decodeAceMusicResponse(body);
  return { audio: decoded.audio, contentType: decoded.contentType, provider: 'acemusic', model: payload.model, info: decoded.info };
}
