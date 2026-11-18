// Simulated network only: no real YouTube, worker or Yemot is contacted here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareYouTubePlayback, playbackFailureMessage, classifyWorkerFailure } from '../youtube-playback-prepare.js';

const quiet = { info() {}, warn() {} };
// AbortSignal.timeout timers are unref'd; a live server keeps the loop busy,
// a test file does not, so hold the loop open while tests run.
const keepAlive = setInterval(() => {}, 1000);
import { after } from 'node:test';
after(() => clearInterval(keepAlive));
const video = { videoId: 'J8Kqjlh-t5g', title: 'test' };
const workerEnv = { YOUTUBE_AUDIO_WORKER_URL: 'https://worker.example', YOUTUBE_AUDIO_WORKER_SECRET: 's'.repeat(30) };

test('worker ready result is used without fallback', async () => {
  let direct = 0;
  const r = await prepareYouTubePlayback(video, {
    env: workerEnv, log: quiet,
    fetchImpl: async () => Response.json({ status: 'ready', playbackPaths: ['/2/a_001'] }),
    downloadToYemot: async () => { direct++; return { playbackPaths: ['/x'] }; }
  });
  assert.deepEqual(r.playbackPaths, ['/2/a_001']);
  assert.equal(r.via, 'worker');
  assert.equal(direct, 0);
});

test('platform 502 HTML from worker is worker_unreachable and falls back', async () => {
  const r = await prepareYouTubePlayback(video, {
    env: workerEnv, log: quiet,
    fetchImpl: async () => new Response('<html>Bad Gateway</html>', { status: 502 }),
    downloadToYemot: async () => ({ playbackPaths: ['/2/youtube_authorized/x_001'] })
  });
  assert.equal(r.via, 'direct');
  assert.equal(r.attempts[0].code, 'worker_unreachable');
});

test('both paths refused by YouTube report the refusal, not "no mapping"', async () => {
  await assert.rejects(prepareYouTubePlayback(video, {
    env: workerEnv, log: quiet,
    fetchImpl: async () => Response.json({ status: 'error', reason: 'audio_source_unavailable' }, { status: 502 }),
    downloadToYemot: async () => { throw Object.assign(new Error('YouTube audio unavailable'), { code: 'youtube_login_required' }); }
  }), err => err.code === 'youtube_login_required' && err.attempts.length === 2);
});

test('total budget aborts a hanging worker and still leaves time for fallback', async () => {
  const started = Date.now();
  let sawSignal = null;
  const r = await prepareYouTubePlayback(video, {
    env: { ...workerEnv, YOUTUBE_PLAYBACK_TOTAL_BUDGET_MS: '6000', YOUTUBE_AUDIO_WORKER_TIMEOUT_MS: '300' }, log: quiet,
    fetchImpl: (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))),
    downloadToYemot: async (id, opts) => { sawSignal = opts.signal; return { playbackPaths: ['/p'] }; }
  });
  assert.equal(r.attempts[0].code, 'worker_timeout');
  assert.ok(Date.now() - started < 3000);
  assert.ok(sawSignal instanceof AbortSignal, 'fallback receives a cancellable signal');
});

test('fallback is cancelled at the total deadline', async () => {
  await assert.rejects(prepareYouTubePlayback(video, {
    env: { YOUTUBE_PLAYBACK_TOTAL_BUDGET_MS: '5200' }, log: quiet,
    downloadToYemot: (id, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  }), err => err.code === 'timeout');
});

test('empty playback list is never treated as ready', async () => {
  await assert.rejects(prepareYouTubePlayback(video, {
    env: {}, log: quiet, downloadToYemot: async () => ({ playbackPaths: [] })
  }), err => err.code === 'no_playback_files');
});

test('worker failure classification', () => {
  assert.equal(classifyWorkerFailure(502, null), 'worker_unreachable');
  assert.equal(classifyWorkerFailure(504, { status: 'error', reason: 'timeout' }), 'worker_timeout');
  assert.equal(classifyWorkerFailure(422, { status: 'unavailable' }), 'youtube_unavailable');
  assert.equal(classifyWorkerFailure(422, { status: 'unavailable', reason: 'audio_source_unavailable' }), 'youtube_source_refused');
  assert.equal(classifyWorkerFailure(401, { status: 'error', reason: 'unauthorized' }), 'worker_unauthorized');
});

test('caller messages distinguish refusal, timeout and generic failure', () => {
  assert.match(playbackFailureMessage('youtube_login_required'), /יוטיוב לא מאפשר/);
  assert.match(playbackFailureMessage('timeout'), /יותר מדי זמן/);
  assert.match(playbackFailureMessage('whatever'), /לא הצלחתי/);
});
