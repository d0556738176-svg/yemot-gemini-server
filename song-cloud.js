// Extension 4 free music engine: the official ACE-Step 1.5 model runs on a
// free GitHub Actions runner (CPU, no card, no outside account), started per
// song with workflow_dispatch. The runner posts the finished mp3 back to
// /song-worker/callback with a one-time ticket.
//
// A song takes several minutes on CPU, so the caller may hang up meanwhile and
// this service (free plan) may even restart. The callback therefore carries
// everything needed to finish the song on its own: when nobody is waiting for
// it in memory, the registered orphan handler converts, uploads and lists it.
//
// Env: GITHUB_DISPATCH_TOKEN (fine-grained or classic token that may run
// workflows on the repo), SONG_CALLBACK_SECRET (random), PUBLIC_BASE_URL or
// RENDER_EXTERNAL_URL, optional SONG_WORKER_REPO (owner/name),
// SONG_WORKER_WORKFLOW (file name), SONG_WORKER_REF (branch).
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const pending = new Map();
// Songs whose mp3 already arrived (the watcher then stops).
const delivered = new Set();
let orphanHandler = null;
const log = (event, details = {}) => console.info('[SONG_CLOUD]', event, details);

function env(name, fallback = '') { return String(process.env[name] || fallback).trim(); }
function publicBase() {
  return env('PUBLIC_BASE_URL') || env('RENDER_EXTERNAL_URL') || 'https://yemot-gemini-server.onrender.com';
}

export function isCloudWorkerConfigured() {
  return !!env('GITHUB_DISPATCH_TOKEN') && !!env('SONG_CALLBACK_SECRET');
}

export function ticketFor(jobId, secret = env('SONG_CALLBACK_SECRET')) {
  return createHmac('sha256', secret).update('song:' + jobId).digest('hex');
}

export function verifyTicket(jobId, ticket, secret = env('SONG_CALLBACK_SECRET')) {
  if (!secret || !jobId || !ticket) return false;
  const a = Buffer.from(ticketFor(jobId, secret));
  const b = Buffer.from(String(ticket));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function onOrphanSong(handler) { orphanHandler = handler; }

// Everything the runner needs (and echoes back), kept small: the workflow
// input limit is 65 KB in total.
export function buildJobPayload(spec, meta = {}) {
  return {
    lyrics: String(spec.lyrics || '').slice(0, 5000),
    prompt: String(spec.musicPrompt || [spec.genre, spec.mood, spec.tempo].filter(Boolean).join(', ') || 'song with clear vocals').slice(0, 900),
    language: String(spec.language || 'he').slice(0, 12),
    duration: Math.max(30, Math.min(240, Math.round(Number(spec.durationSeconds) || 90))),
    title: String(spec.title || meta.title || 'שיר חדש').slice(0, 120),
    caller: String(meta.caller || '').slice(0, 40),
    callId: String(meta.callId || '').slice(0, 80)
  };
}

export async function dispatchSongJob(jobId, payload) {
  const repo = env('SONG_WORKER_REPO', 'd0556738176-svg/yemot-gemini-server');
  const workflow = env('SONG_WORKER_WORKFLOW', 'song-worker.yml');
  const ref = env('SONG_WORKER_REF', 'main');
  const body = {
    ref,
    inputs: {
      job_id: jobId,
      callback_url: publicBase().replace(/\/+$/, '') + '/song-worker/callback',
      ticket: ticketFor(jobId),
      payload: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    }
  };
  const r = await fetch('https://api.github.com/repos/' + repo + '/actions/workflows/' + encodeURIComponent(workflow) + '/dispatches', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env('GITHUB_DISPATCH_TOKEN'),
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'yemot-song-worker'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (r.status !== 204 && r.status !== 200) {
    const text = await r.text().catch(() => '');
    throw Object.assign(new Error('GitHub dispatch HTTP ' + r.status + ': ' + text.slice(0, 200)), { status: r.status === 401 || r.status === 403 || r.status === 404 ? r.status : 503 });
  }
  log('DISPATCHED', { jobId, workflow, ref });
}

// Music-engine entry point used by song-generator's provider chain.
export async function generateWithCloudWorker(spec, meta = {}) {
  if (!isCloudWorkerConfigured()) throw Object.assign(new Error('Cloud song worker is not configured'), { status: 503 });
  const jobId = meta.jobId || randomUUID();
  const timeoutMs = Math.max(5 * 60000, Math.min(60 * 60000, Number(process.env.SONG_WORKER_TIMEOUT_MS || 45 * 60000)));
  const payload = buildJobPayload(spec, meta);
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(jobId);
      reject(Object.assign(new Error('Cloud song worker timed out'), { status: 408 }));
    }, timeoutMs);
    pending.set(jobId, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); }, meta, startedAt: Date.now() });
  });
  try {
    await dispatchSongJob(jobId, payload);
  } catch (error) {
    pending.get(jobId)?.reject(error);
    pending.delete(jobId);
    throw error;
  }
  watchRun(jobId, payload);
  return result;
}

// 15.11: a runner that crashes (it ran out of disk) never calls back, and the
// caller's song was lost after a long wait. Every 2 minutes the run is looked
// up on GitHub; a run that ended without success is sent again (same job, so
// the same waiter gets the song), at most twice.
export async function findRun(jobId, since, { fetchImpl = fetch } = {}) {
  const repo = env('SONG_WORKER_REPO', 'd0556738176-svg/yemot-gemini-server');
  const workflow = env('SONG_WORKER_WORKFLOW', 'song-worker.yml');
  const r = await fetchImpl('https://api.github.com/repos/' + repo + '/actions/workflows/' + encodeURIComponent(workflow) + '/runs?event=workflow_dispatch&per_page=30', {
    headers: { authorization: 'Bearer ' + env('GITHUB_DISPATCH_TOKEN'), accept: 'application/vnd.github+json', 'user-agent': 'yemot-song-worker' },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return (j?.workflow_runs || []).filter(x => x.display_title === 'song ' + jobId && Date.parse(x.created_at) >= since - 60000)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] || null;
}

export function watchRun(jobId, payload, { everyMs = 120000, maxRetries = 2, fetchImpl = fetch, dispatch = dispatchSongJob } = {}) {
  let retries = 0, since = Date.now();
  const started = Date.now();
  // Goes on after the caller hung up or his wait ended: a resent song is then
  // finished on its own (orphan path) and still lands in extension 7.
  const timer = setInterval(async () => {
    if (delivered.has(jobId) || Date.now() - started > 3 * 3600000) return clearInterval(timer);
    try {
      const run = await findRun(jobId, since, { fetchImpl });
      if (!run || run.status !== 'completed' || run.conclusion === 'success') return;
      if (delivered.has(jobId)) return clearInterval(timer);
      if (retries >= maxRetries) {
        clearInterval(timer);
        const w = pending.get(jobId); pending.delete(jobId);
        log('WORKER_GAVE_UP', { jobId, conclusion: run.conclusion, retries });
        w?.reject(Object.assign(new Error('Cloud worker failed ' + (retries + 1) + ' times'), { status: 502 }));
        return;
      }
      retries++; since = Date.now();
      log('WORKER_RUN_FAILED_RETRYING', { jobId, conclusion: run.conclusion, retry: retries });
      await dispatch(jobId, payload);
    } catch (e) { log('WORKER_WATCH_ERROR', { jobId, message: String(e?.message || e).slice(0, 120) }); }
  }, everyMs);
  timer.unref?.();
  return timer;
}

export function cloudJobStatus(jobId) {
  const p = pending.get(jobId);
  return p ? { waiting: true, seconds: Math.round((Date.now() - p.startedAt) / 1000), stage: p.stage || 'queued' } : { waiting: false };
}

// Express handler: POST /song-worker/callback?job=..&ticket=..&kind=audio|status|error
// Body for kind=audio: the mp3 bytes; header x-song-payload: base64 JSON payload.
export async function handleWorkerCallback(req, res) {
  const jobId = String(req.query?.job || '').slice(0, 80);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(jobId) || !verifyTicket(jobId, req.query?.ticket)) {
    log('CALLBACK_REJECTED', { jobId: jobId.slice(0, 12) });
    return res.status(403).json({ ok: false });
  }
  const kind = String(req.query?.kind || 'audio');
  const waiter = pending.get(jobId);
  if (kind === 'status') {
    if (waiter) waiter.stage = String(req.query?.stage || '').slice(0, 40);
    log('WORKER_STATUS', { jobId, stage: req.query?.stage, waiting: !!waiter });
    return res.json({ ok: true, waiting: !!waiter });
  }
  if (kind === 'error') {
    const message = String(req.query?.message || 'worker failed').slice(0, 300);
    log('WORKER_FAILED', { jobId, message, waiting: !!waiter });
    if (waiter) { pending.delete(jobId); waiter.reject(Object.assign(new Error('Cloud worker failed: ' + message), { status: 502 })); }
    return res.json({ ok: true });
  }
  const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (audio.length < 20000) {
    log('CALLBACK_EMPTY_AUDIO', { jobId, bytes: audio.length });
    if (waiter) { pending.delete(jobId); waiter.reject(Object.assign(new Error('Cloud worker returned no audio'), { status: 502 })); }
    return res.status(400).json({ ok: false });
  }
  let payload = {};
  try { payload = JSON.parse(Buffer.from(String(req.headers['x-song-payload'] || ''), 'base64').toString('utf8')); } catch {}
  const flac = audio.subarray(0, 4).toString('latin1') === 'fLaC';
  const generated = { audio, contentType: flac ? 'audio/flac' : 'audio/mpeg', provider: 'github-cpu', model: 'acestep-v15-turbo' };
  delivered.add(jobId);
  log('AUDIO_RECEIVED', { jobId, bytes: audio.length, waiting: !!waiter });
  res.json({ ok: true });
  if (waiter) {
    pending.delete(jobId);
    waiter.resolve(generated);
  } else if (orphanHandler) {
    // Nobody waits any more (caller hung up long ago or the service
    // restarted): finish the song on its own so it still lands in the system.
    Promise.resolve(orphanHandler(generated, payload, jobId)).catch(error =>
      log('ORPHAN_FAILED', { jobId, message: String(error?.message || error).slice(0, 200) }));
  }
}
