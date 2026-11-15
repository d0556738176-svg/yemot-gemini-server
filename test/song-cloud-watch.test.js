import test from 'node:test';
import assert from 'node:assert/strict';
import { watchRun, findRun } from '../song-cloud.js';

const runs = conclusion => async () => ({ ok: true, json: async () => ({ workflow_runs: [{ display_title: 'song job-12345678', created_at: new Date().toISOString(), status: 'completed', conclusion }] }) });

test('a crashed song run is found and sent again', async () => {
  const sent = [];
  const t = watchRun('job-12345678', { title: 'x' }, { everyMs: 20, fetchImpl: runs('failure'), dispatch: async id => { sent.push(id); } });
  await new Promise(r => setTimeout(r, 120));
  clearInterval(t);
  assert.ok(sent.length >= 1 && sent.length <= 2, 'resent at most twice: ' + sent.length);
  assert.equal(sent[0], 'job-12345678');
});

test('a successful run is never sent again', async () => {
  const sent = [];
  const t = watchRun('job-87654321', {}, { everyMs: 20, fetchImpl: async () => ({ ok: true, json: async () => ({ workflow_runs: [{ display_title: 'song job-87654321', created_at: new Date().toISOString(), status: 'completed', conclusion: 'success' }] }) }), dispatch: async id => { sent.push(id); } });
  await new Promise(r => setTimeout(r, 100));
  clearInterval(t);
  assert.equal(sent.length, 0);
});

test('findRun ignores runs of other songs', async () => {
  assert.equal(await findRun('job-00000000', Date.now(), { fetchImpl: runs('failure') }), null);
});
