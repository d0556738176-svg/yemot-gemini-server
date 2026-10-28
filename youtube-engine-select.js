// Branch 2: pick the Apify actor by the selected video's length, so each
// download uses the cheaper engine.
//
//   memo23  — flat ~$0.04 per file regardless of length (cheap for long
//             shiurim; relatively expensive for short songs, and its start
//             fee is ~$0.02 even on a failed run).
//   s-r     — ~$0.002 start + ~$0.0048/MB (cheaper for short songs, and ~10x
//             cheaper when a run fails, because its start fee is tiny).
//
// Cost crossover is around 8-10 minutes, so short videos go to s-r and long
// ones to memo23. On ANY uncertainty we fall back to the long/flat actor,
// which works for every length.
const SHORT_DEFAULT = 's-r/youtube-video-downloader';
const LONG_DEFAULT = 'memo23/youtube-video-downloader';

export function parseIsoDurationSeconds(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return null;
  const d = Number(m[1] || 0), h = Number(m[2] || 0), mi = Number(m[3] || 0), s = Number(m[4] || 0);
  const total = d * 86400 + h * 3600 + mi * 60 + s;
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

// Look up a single video's duration via the YouTube Data API. Returns seconds,
// or null when the key is missing, the id is malformed, or the API fails — the
// caller then uses the safe long-actor fallback.
export async function fetchVideoDurationSeconds(videoId, env = process.env, fetchImpl = fetch) {
  const key = String(env.YOUTUBE_API_KEY || '').trim();
  if (!key || !/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) return null;
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'contentDetails');
  url.searchParams.set('id', String(videoId));
  url.searchParams.set('key', key);
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(Number(env.YOUTUBE_DURATION_TIMEOUT_MS || 8000)) });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  return parseIsoDurationSeconds(data?.items?.[0]?.contentDetails?.duration);
}

// Returns { actor, seconds, reason }. actor is the Apify actor id to start a
// NEW run with (an existing run's receipt keeps its own recorded actor).
export async function pickApifyActor(videoId, env = process.env, fetchImpl = fetch) {
  const shortActor = String(env.BRANCH2_APIFY_ACTOR_SHORT || SHORT_DEFAULT).trim();
  const longActor = String(env.BRANCH2_APIFY_ACTOR_LONG || env.BRANCH2_APIFY_ACTOR || LONG_DEFAULT).trim();
  // Routing can be turned off to force a single actor (the long one).
  if (String(env.BRANCH2_ENGINE_ROUTING || 'on').toLowerCase() === 'off') {
    return { actor: longActor, seconds: null, reason: 'routing_off' };
  }
  const threshold = Number(env.BRANCH2_ENGINE_LENGTH_THRESHOLD_SEC || 600);
  let seconds = null;
  try { seconds = await fetchVideoDurationSeconds(videoId, env, fetchImpl); } catch { seconds = null; }
  if (!Number.isFinite(seconds) || seconds <= 0) return { actor: longActor, seconds: null, reason: 'unknown_length' };
  return seconds <= threshold
    ? { actor: shortActor, seconds, reason: 'short' }
    : { actor: longActor, seconds, reason: 'long' };
}
