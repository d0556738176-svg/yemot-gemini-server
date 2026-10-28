// Branch 2: prepare playable Yemot files for one selected YouTube video.
//
// One total time budget covers every path (audio worker, then the in-process
// download). Before this module the worker (up to 120 s) and the fallback
// (up to 90 s) were awaited back to back while Yemot held the same HTTP
// request open, and a timed-out promise kept running in the background.
// Here every path receives an AbortSignal tied to the remaining budget, so
// work really stops when the caller can no longer be answered.

const DEFAULT_TOTAL_BUDGET_MS = 75000;
const DEFAULT_WORKER_SHARE_MS = 45000;
const MIN_FALLBACK_MS = 5000;

// Codes meaning YouTube itself refused anonymous access from this server.
// Retrying through another path on the same server will not change that.
export const YOUTUBE_REFUSAL_CODES = new Set([
  'youtube_login_required',
  'youtube_bot_check',
  'youtube_forbidden',
  'youtube_rate_limited',
  'youtube_age_restricted'
]);

function numberEnv(env, key, fallback) {
  const n = Number(env?.[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

// The worker returns {status, reason}; map its reasons to the same codes the
// in-process path uses. A non-JSON body (e.g. a platform 502 page) is reported
// as worker_unreachable, not as a YouTube problem.
export function classifyWorkerFailure(httpStatus, body) {
  if (!body || typeof body !== 'object') return 'worker_unreachable';
  const reason = String(body.reason || body.code || '').toLowerCase();
  if (/bot|sign.?in|login/.test(reason)) return 'youtube_bot_check';
  if (reason === 'timeout' || httpStatus === 504) return 'worker_timeout';
  if (httpStatus === 401) return 'worker_unauthorized';
  if (httpStatus === 429) return 'worker_rate_limited';
  // Checked before the generic 'unavailable' status: in production logs this
  // reason came with HTTP 422 and yt-dlp's "Sign in to confirm you're not a bot".
  if (reason === 'audio_source_unavailable') return 'youtube_source_refused';
  if (body.status === 'unavailable' || httpStatus === 422) return 'youtube_unavailable';
  return 'worker_failed';
}

export async function prepareYouTubePlayback(video, deps) {
  const {
    env = process.env,
    fetchImpl = fetch,
    resolveAlternate = async () => null,
    downloadToYemot,
    log = console,
    signal: callerSignal
  } = deps || {};
  const videoId = String(video?.videoId || '').trim();
  if (!videoId) throw codedError('invalid_video', 'Missing video id');

  const totalMs = numberEnv(env, 'YOUTUBE_PLAYBACK_TOTAL_BUDGET_MS', DEFAULT_TOTAL_BUDGET_MS);
  const started = Date.now();
  const remaining = () => totalMs - (Date.now() - started);
  const deadline = AbortSignal.timeout(totalMs);
  const overall = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const attempts = [];

  const workerBase = String(env.YOUTUBE_AUDIO_WORKER_URL || '').trim().replace(/\/$/, '');
  const workerSecret = String(env.YOUTUBE_AUDIO_WORKER_SECRET || '').trim();
  if (workerBase && workerSecret) {
    const workerMs = Math.min(
      numberEnv(env, 'YOUTUBE_AUDIO_WORKER_TIMEOUT_MS', DEFAULT_WORKER_SHARE_MS),
      Math.max(0, remaining() - MIN_FALLBACK_MS)
    );
    if (workerMs > 0) {
      try {
        const response = await fetchImpl(workerBase + '/prepare-audio', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + workerSecret },
          body: JSON.stringify({ videoId, title: String(video.title || ''), requestId: crypto.randomUUID() }),
          signal: AbortSignal.any([overall, AbortSignal.timeout(workerMs)])
        });
        const body = await response.json().catch(() => null);
        const paths = Array.isArray(body?.playbackPaths) ? body.playbackPaths.map(String).filter(Boolean) : [];
        if (response.ok && body?.status === 'ready' && paths.length) {
          log.info('[YouTube IVR] audio worker ready', { videoId, chunks: paths.length, cached: Boolean(body.cached) });
          return { playbackPaths: paths, via: 'worker', attempts };
        }
        const code = classifyWorkerFailure(response.status, body);
        attempts.push({ path: 'worker', code, httpStatus: response.status });
        log.warn('[YouTube IVR] audio worker did not prepare audio', { videoId, httpStatus: response.status, code, reason: String(body?.reason || '').slice(0, 60) });
      } catch (error) {
        const code = callerSignal?.aborted ? 'caller_gone'
          : (error?.name === 'TimeoutError' || error?.name === 'AbortError') ? 'worker_timeout' : 'worker_unreachable';
        attempts.push({ path: 'worker', code });
        log.warn('[YouTube IVR] audio worker request failed', { videoId, code });
        if (code === 'caller_gone') throw codedError('caller_gone', 'Caller hung up', { attempts });
      }
    }
  }

  if (remaining() < MIN_FALLBACK_MS) {
    throw codedError(attempts.at(-1)?.code || 'timeout', 'No time left for fallback playback preparation', { attempts });
  }

  let alternate = null;
  try {
    alternate = await resolveAlternate(video);
    if (alternate) log.info('[YouTube IVR] publisher audio fallback matched', { videoId, source: alternate.source, score: alternate.score });
  } catch (error) {
    log.warn('[YouTube IVR] publisher audio fallback unavailable', { videoId, message: String(error?.message || '').slice(0, 120) });
  }

  try {
    const playback = await downloadToYemot(videoId, { fallbackUrl: alternate?.url || null, signal: overall });
    if (!playback?.playbackPaths?.length) throw codedError('no_playback_files', 'No playback files generated');
    log.info('[YouTube IVR] direct playback ready', { videoId, chunks: playback.playbackPaths.length });
    return { playbackPaths: playback.playbackPaths, via: 'direct', attempts };
  } catch (error) {
    let code = error?.code || 'direct_failed';
    if (callerSignal?.aborted) code = 'caller_gone';
    else if (deadline.aborted) code = 'timeout';
    attempts.push({ path: 'direct', code });
    // If both paths saw YouTube refuse this server, report that, since it is
    // the actionable root cause; otherwise report the last failure.
    const refusal = attempts.find(a => YOUTUBE_REFUSAL_CODES.has(a.code));
    throw codedError(refusal ? refusal.code : code, 'Playback preparation failed: ' + String(error?.message || code).slice(0, 160), { attempts, cause: error });
  }
}

// Short Hebrew explanation for the caller, chosen by failure code.
export function playbackFailureMessage(code) {
  if (YOUTUBE_REFUSAL_CODES.has(code) || code === 'youtube_source_refused')
    return 'יוטיוב לא מאפשר כרגע לשרת שלנו להוריד את הסרטון הזה, ולכן אי אפשר להשמיע אותו. אמור מספר של תוצאה אחרת, או אמור חיפוש חדש.';
  if (code === 'youtube_unplayable' || code === 'youtube_unavailable' || code === 'no_audio_format')
    return 'הסרטון הזה אינו זמין להשמעה. אמור מספר של תוצאה אחרת, או אמור חיפוש חדש.';
  if (code === 'too_large')
    return 'הסרטון הזה ארוך מדי להשמעה בטלפון. אמור מספר של תוצאה אחרת, או אמור חיפוש חדש.';
  if (code === 'timeout' || code === 'worker_timeout')
    return 'הכנת ההשמעה לקחה יותר מדי זמן. אפשר לנסות שוב את אותה תוצאה, או לבחור תוצאה אחרת.';
  return 'לא הצלחתי להשמיע את התוצאה הזאת כרגע. התוצאות נשארו זמינות. אמור מספר של תוצאה אחרת, או אמור חיפוש חדש.';
}
