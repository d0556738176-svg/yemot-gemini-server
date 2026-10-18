import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server.js';
import { createWorker } from './worker.js';

const USER_TOKEN = 'test-user-token-long-enough-for-branch5';
const WORKER_TOKEN = 'test-worker-token-long-enough-for-branch5';

async function withServer(fn) {
  const server = createServer({
    token: USER_TOKEN,
    workerToken: WORKER_TOKEN,
    workerProtocolEnabled: true
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('worker requires an adapter and refuses non-loopback HTTP credentials', () => {
  assert.throws(() => createWorker({
    baseUrl: 'http://example.com',
    token: WORKER_TOKEN,
    adapter: { executeReadOnlyTask: async () => ({ verified: true, text: 'x' }) }
  }), /HTTPS/);
  assert.throws(() => createWorker({
    baseUrl: 'http://127.0.0.1:1234',
    token: WORKER_TOKEN
  }), /verified extension adapter/);
});

test('worker reports completion only for adapter results marked verified', async () => {
  await withServer(async baseUrl => {
    const enqueue = await fetch(baseUrl + '/api/task', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + USER_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Read the public title of a page', mode: 'read_only' })
    });
    assert.equal(enqueue.status, 202);

    const worker = createWorker({
      baseUrl,
      token: WORKER_TOKEN,
      adapter: {
        async executeReadOnlyTask({ task }) {
          assert.equal(task, 'Read the public title of a page');
          return { verified: true, text: 'Verified public page title: Example' };
        }
      }
    });
    assert.equal(await worker.runOnce(), true);

    const status = await fetch(baseUrl + '/api/status', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + USER_TOKEN }
    });
    assert.equal((await status.json()).queuedJobs, 0);
  });
});

test('worker never reports an unverified adapter response as completed', async () => {
  await withServer(async baseUrl => {
    const enqueue = await fetch(baseUrl + '/api/task', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + USER_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Read a public page' })
    });
    assert.equal(enqueue.status, 202);
    const worker = createWorker({
      baseUrl,
      token: WORKER_TOKEN,
      adapter: { async executeReadOnlyTask() { return { verified: false, text: 'maybe' }; } }
    });
    await worker.runOnce();
    const claim = await fetch(baseUrl + '/api/worker/claim', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + WORKER_TOKEN, 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal((await claim.json()).task, null);
  });
});
