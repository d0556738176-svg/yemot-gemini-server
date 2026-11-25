import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'song-state-'));
process.env.SONG_STATE_DIR = dir;
process.env.SONG_CALLBACK_SECRET = 'test-secret';
writeFileSync(path.join(dir, 'song-cloud-jobs.json'), JSON.stringify({
  'job-resume-0001': { payload: { title: 'x' }, titles: ['warm-abc'], since: Date.now(), at: Date.now() },
  'job-old-000001': { payload: { title: 'y' }, at: Date.now() - 5 * 3600000 }
}));
const cloud = await import('../song-cloud.js');

const liveRun = title => async url => String(url).endsWith('/cancel')
  ? { ok: true, status: 202 }
  : { ok: true, json: async () => ({ workflow_runs: [{ id: 77, display_title: title, created_at: new Date().toISOString(), status: 'in_progress', conclusion: null }] }) };

test('a runner silent for too long is cancelled and the song sent again', async () => {
  const sent = [], cancelled = [];
  const t = cloud.watchRun('job-silent-01', {}, {
    everyMs: 15, stallMs: 1, firstBeatMs: 1, fetchImpl: liveRun('song job-silent-01'),
    dispatch: async id => { sent.push(id); }, cancel: async id => { cancelled.push(id); return true; }
  });
  await new Promise(r => setTimeout(r, 150));
  clearInterval(t);
  assert.ok(sent.length >= 1 && sent.length <= 2, 'sent again at most twice: ' + sent.length);
  assert.ok(cancelled.includes(77));
});

test('a runner that keeps sending signs of life is left alone', async () => {
  const sent = [];
  const res = () => ({ json() {}, status() { return this; } });
  const t = cloud.watchRun('job-alive-001', {}, {
    everyMs: 15, stallMs: 60000, firstBeatMs: 60000, fetchImpl: liveRun('song job-alive-001'),
    dispatch: async id => { sent.push(id); }, cancel: async () => true
  });
  await cloud.handleWorkerCallback({ query: { job: 'job-alive-001', ticket: cloud.ticketFor('job-alive-001'), kind: 'status', stage: 'alive' }, headers: {} }, res());
  await new Promise(r => setTimeout(r, 100));
  clearInterval(t);
  assert.equal(sent.length, 0);
});

test('after delivery the second runner is told to stop, and no second copy is made', async () => {
  const id = 'job-done-0001', ticket = cloud.ticketFor(id);
  const out = [];
  const res = () => ({ json(v) { out.push(v); return this; }, status() { return this; } });
  const audio = Buffer.alloc(30000, 1);
  let orphans = 0;
  cloud.onOrphanSong(async () => { orphans++; });
  await cloud.handleWorkerCallback({ query: { job: id, ticket, kind: 'audio' }, headers: {}, body: audio }, res());
  await cloud.handleWorkerCallback({ query: { job: id, ticket, kind: 'status', stage: 'alive' }, headers: {} }, res());
  await cloud.handleWorkerCallback({ query: { job: id, ticket, kind: 'audio' }, headers: {}, body: audio }, res());
  await new Promise(r => setTimeout(r, 20));
  assert.equal(out[1].done, true);
  assert.equal(out[2].duplicate, true);
  assert.equal(orphans, 1);
  // Kept on disk, so a restart does not forget it.
  assert.ok(JSON.parse(readFileSync(path.join(dir, 'song-delivered.json'), 'utf8')).includes(id));
});

test('after a restart the songs still being made get their watcher back', () => {
  const watched = [];
  const n = cloud.resumeCloudJobs({ watch: (id, payload, o) => { watched.push([id, o.titles]); } });
  assert.equal(n, 1);
  assert.deepEqual(watched, [['job-resume-0001', ['warm-abc']]]);
  assert.equal(cloud.isCloudJobActive('job-old-000001'), false);
});
