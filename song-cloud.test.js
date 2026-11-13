import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketFor, verifyTicket, buildJobPayload, handleWorkerCallback, generateWithCloudWorker, onOrphanSong, cloudJobStatus } from './song-cloud.js';
import { waitMessage } from './song-ivr.js';

function res() {
  const r = { code: 200, body: null };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}

test('tickets are per job and verified in constant time', () => {
  const t = ticketFor('job-12345678', 's1');
  assert.ok(verifyTicket('job-12345678', t, 's1'));
  assert.ok(!verifyTicket('job-12345679', t, 's1'));
  assert.ok(!verifyTicket('job-12345678', t, 's2'));
  assert.ok(!verifyTicket('job-12345678', '', 's1'));
});

test('job payload keeps Hebrew lyrics, clamps duration and stays small', () => {
  const p = buildJobPayload({ lyrics: 'שבת שלום'.repeat(2000), musicPrompt: 'joyful, male vocals', durationSeconds: 999, title: 'שבת' }, { callId: 'c1' });
  assert.equal(p.duration, 240);
  assert.equal(p.lyrics.length, 5000);
  assert.equal(p.language, 'he');
  assert.ok(Buffer.from(JSON.stringify(p)).toString('base64').length < 60000);
});

test('worker flow: dispatch, status, audio callback resolves the waiting song', async () => {
  process.env.GITHUB_DISPATCH_TOKEN = 'gh';
  process.env.SONG_CALLBACK_SECRET = 'sec';
  process.env.PUBLIC_BASE_URL = 'https://example.test';
  const original = globalThis.fetch;
  let dispatched;
  globalThis.fetch = async (url, init) => { dispatched = { url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization }; return new Response(null, { status: 204 }); };
  try {
    const jobId = '11111111-2222-3333-4444-555555555555';
    const p = generateWithCloudWorker({ lyrics: 'שלום', musicPrompt: 'pop', durationSeconds: 60, title: 'ט' }, { jobId });
    await new Promise(r => setImmediate(r));
    assert.match(dispatched.url, /actions\/workflows\/song-worker\.yml\/dispatches$/);
    assert.equal(dispatched.auth, 'Bearer gh');
    assert.equal(dispatched.body.inputs.callback_url, 'https://example.test/song-worker/callback');
    const ticket = dispatched.body.inputs.ticket;
    const r1 = res();
    await handleWorkerCallback({ query: { job: jobId, ticket, kind: 'status', stage: 'generating' }, headers: {}, body: {} }, r1);
    assert.equal(cloudJobStatus(jobId).stage, 'generating');
    const bad = res();
    await handleWorkerCallback({ query: { job: jobId, ticket: 'x', kind: 'audio' }, headers: {}, body: Buffer.alloc(30000) }, bad);
    assert.equal(bad.code, 403);
    const r2 = res();
    await handleWorkerCallback({ query: { job: jobId, ticket, kind: 'audio' }, headers: {}, body: Buffer.alloc(30000, 1) }, r2);
    const got = await p;
    assert.equal(got.provider, 'github-cpu');
    assert.equal(got.audio.length, 30000);
  } finally { globalThis.fetch = original; }
});

test('a song nobody waits for is handed to the orphan handler with its payload', async () => {
  process.env.SONG_CALLBACK_SECRET = 'sec';
  let seen;
  onOrphanSong((g, payload, id) => { seen = { bytes: g.audio.length, title: payload.title, id }; });
  const jobId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const payload = Buffer.from(JSON.stringify({ title: 'שיר', lyrics: 'x' })).toString('base64');
  await handleWorkerCallback({ query: { job: jobId, ticket: ticketFor(jobId, 'sec'), kind: 'audio' }, headers: { 'x-song-payload': payload }, body: Buffer.alloc(25000, 2) }, res());
  await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, { bytes: 25000, title: 'שיר', id: jobId });
});

test('waiting caller hears the title first, then progress with minutes and the way out', () => {
  assert.match(waitMessage({ title: 'שבת', first: true }), /"שבת".*הקישו אפס.*שלוחה שבע/);
  assert.match(waitMessage({ elapsedSec: 130, stage: 'generating' }), /מלחין.*2 דקות.*אפס/);
});
