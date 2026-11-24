// Owner, 24.11: runners made ready while the caller chooses; two per song.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GITHUB_DISPATCH_TOKEN = 'x'; process.env.SONG_CALLBACK_SECRET = 'secret-for-tests';
process.env.SONG_EVENTS_FILE = '/tmp/song-events-test.json';
const C = await import('../song-cloud.js');
const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } }; return r; };

test('two warm runners get the same song; the first song plays, the second is ignored, one failure is not the end', async () => {
  const dispatched = [];
  globalThis.fetch = async (url, opt) => { dispatched.push(JSON.parse(opt.body).inputs.job_id); return { status: 204, text: async () => '' }; };
  assert.equal(await C.prewarmRunners(2), 2);
  const warmIds = [...dispatched];
  // No song yet: 204.
  let r = res(); C.handleWorkerNext({ query: { job: warmIds[0], ticket: C.ticketFor(warmIds[0]) } }, r); assert.equal(r.code, 204);
  const song = C.generateWithCloudWorker({ lyrics: 'שבת', musicPrompt: 'pop', durationSeconds: 60 }, { jobId: 'job-aaaaaaaa' });
  await new Promise(x => setTimeout(x, 10));
  assert.equal(dispatched.length, 2, 'no new runner: both warm ones were used');
  const got = [];
  for (const id of warmIds) { r = res(); C.handleWorkerNext({ query: { job: id, ticket: C.ticketFor(id) } }, r); got.push(r.body); }
  assert.ok(got.every(g => g.job === 'job-aaaaaaaa'));
  const p1 = JSON.parse(Buffer.from(got[0].payload, 'base64').toString()), p2 = JSON.parse(Buffer.from(got[1].payload, 'base64').toString());
  assert.equal(p1.seed, p2.seed, 'same seed on both runners');
  // One runner fails: the song still waits for the other.
  r = res(); await C.handleWorkerCallback({ query: { job: 'job-aaaaaaaa', ticket: got[0].ticket, kind: 'error', message: 'oom' }, headers: {} }, r);
  const audio = Buffer.alloc(30000, 1);
  r = res(); await C.handleWorkerCallback({ query: { job: 'job-aaaaaaaa', ticket: got[1].ticket, kind: 'audio' }, headers: {}, body: audio }, r);
  const done = await song;
  assert.equal(done.audio.length, 30000);
  r = res(); await C.handleWorkerCallback({ query: { job: 'job-aaaaaaaa', ticket: got[1].ticket, kind: 'audio' }, headers: {}, body: audio }, r);
  assert.equal(r.body.duplicate, true);
});
