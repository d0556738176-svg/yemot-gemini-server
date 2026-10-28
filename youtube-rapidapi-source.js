// Branch 2: fetch a direct audio URL for a YouTube video through the YTStream
// RapidAPI service. The download happens on YTStream's infrastructure (with
// their proxies), so this server never talks to YouTube directly — no cookies,
// no token spoofing, no proxy of our own.
//
// Response shape is discovered at runtime and logged (shapes vary), so this
// adapter is defensive about where the audio URL lives.
const DEFAULT_HOST = 'ytstream-download-youtube-videos.p.rapidapi.com';

export function isRapidApiConfigured(env = process.env) {
  return !!String(env.RAPIDAPI_KEY || '').trim();
}

function pickAudioFormat(body) {
  const pools = [body?.adaptiveFormats, body?.formats, body?.audios, body?.links, body?.audio].filter(Array.isArray);
  const candidates = [];
  for (const pool of pools) {
    for (const f of pool) {
      const url = f?.url || f?.link || f?.downloadUrl;
      const mime = String(f?.mimeType || f?.type || f?.ext || '').toLowerCase();
      // Audio only: the mime must start with audio/ (or be a bare audio ext),
      // and must never be a video stream. Picking video/webm by accident sends
      // a huge video down the phone pipe and fails conversion.
      const isAudio = (/^audio\//.test(mime) || /^(m4a|mp3|opus|aac|ogg)$/.test(mime) || f?.audioQuality) && !/^video\//.test(mime);
      if (typeof url === 'string' && url && isAudio) {
        candidates.push({ url, bitrate: Number(f?.bitrate || f?.abr || 0), mime });
      }
    }
  }
  candidates.sort((a, b) => b.bitrate - a.bitrate);
  return candidates[0] || null;
}

// Returns { url, mime, meta } or throws a coded error.
export async function resolveRapidApiAudioUrl(videoId, env = process.env) {
  const key = String(env.RAPIDAPI_KEY || '').trim();
  if (!key) throw Object.assign(new Error('RAPIDAPI_KEY is not configured'), { code: 'not_configured' });
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) throw Object.assign(new Error('invalid video id'), { code: 'invalid_video' });
  const host = String(env.RAPIDAPI_YTSTREAM_HOST || DEFAULT_HOST).trim();
  const url = 'https://' + host + '/dl?id=' + encodeURIComponent(videoId);
  const response = await fetch(url, {
    headers: { 'x-rapidapi-host': host, 'x-rapidapi-key': key },
    signal: AbortSignal.timeout(Number(env.RAPIDAPI_TIMEOUT_MS || 30000))
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  const meta = {
    httpStatus: response.status,
    bodyShape: body && typeof body === 'object' ? Object.keys(body).slice(0, 15).join(',') : 'not-json',
    status: body?.status ?? null,
    adaptiveCount: Array.isArray(body?.adaptiveFormats) ? body.adaptiveFormats.length : null,
    formatsCount: Array.isArray(body?.formats) ? body.formats.length : null,
    errorMessage: body?.errorId || body?.error || body?.message || null
  };
  if (!response.ok) throw Object.assign(new Error('YTStream HTTP ' + response.status), { code: response.status === 429 ? 'rate_limited' : 'http_error', meta });
  if (body?.status && String(body.status).toUpperCase() !== 'OK') {
    throw Object.assign(new Error('YTStream status ' + body.status), { code: 'service_error', meta });
  }
  const audio = pickAudioFormat(body);
  if (!audio) throw Object.assign(new Error('YTStream returned no audio format'), { code: 'no_audio_format', meta });
  const parsed = new URL(audio.url);
  if (parsed.protocol !== 'https:') throw Object.assign(new Error('non-HTTPS audio url'), { code: 'bad_url', meta });
  return { url: audio.url, mime: audio.mime, bitrate: audio.bitrate, meta };
}
