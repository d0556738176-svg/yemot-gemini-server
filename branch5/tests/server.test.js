import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, validateTask } from '../server.js';

const TOKEN = 'test-token-that-is-long-enough-for-test-only';
const WORKER_TOKEN = 'separate-worker-token-long-enough-for-test';

async function withServer(fn, options = {}) {
  const server = createServer({ token: TOKEN, workerToken: WORKER_TOKEN, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const userHeaders = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const workerHeaders = { Authorization: 'Bearer ' + WORKER_TOKEN, 'Content-Type': 'application/json' };

test('health endpoint is public and reports this is only a PoC', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/health');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.service, 'branch5-poc');
    assert.equal(body.adapterReady, false);
    assert.equal(body.workerProtocolEnabled, false);
  });
});

test('status endpoint requires the dedicated bearer token', async () => {
  await withServer(async base => {
    const denied = await fetch(base + '/api/status', { method: 'POST' });
    assert.equal(denied.status, 401);
    const allowed = await fetch(base + '/api/status', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN }
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).browserBridgeConnected, false);
  });
});

test('safe read-only task fails closed without the worker protocol enabled', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/api/task', {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ task: 'Read the public title of example.com', mode: 'read_only' })
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'browser_adapter_not_ready');
  });
});

test('high-impact actions in English and Hebrew are blocked even if caller claims approval', () => {
  for (const task of [
    'Create account on this website',
    'Please submit the form',
    'פתיחת חשבון באתר',
    'שליחת טופס באתר'
  ]) {
    const result = validateTask({ task, approved: true });
    assert.equal(result.ok, false, task);
    assert.equal(result.status, 403, task);
  }
});

test('task length and non-read-only mode are rejected', () => {
  assert.equal(validateTask({ task: 'x'.repeat(1201) }).status, 400);
  assert.equal(validateTask({ task: 'Read a page', mode: 'execute' }).status, 400);
});

test('invalid JSON returns a safe error', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/api/task', {
      method: 'POST',
      headers: userHeaders,
      body: '{invalid'
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_json' });
  });
});

test('oversized request returns HTTP 413 without forcibly dropping the connection', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/api/task', {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ task: 'x'.repeat(9000) })
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'body_too_large' });
  });
});

test('rate limit rejects the eleventh authenticated request in one minute', async () => {
  await withServer(async base => {
    for (let i = 0; i < 10; i++) {
      const response = await fetch(base + '/api/status', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN }
      });
      assert.equal(response.status, 200);
    }
    const limited = await fetch(base + '/api/status', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN }
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'rate_limited' });
  });
});

test('worker endpoints require a separate worker token', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/api/worker/claim', {
      method: 'POST',
      headers: userHeaders,
      body: '{}'
    });
    assert.equal(response.status, 401);
  }, { workerProtocolEnabled: true });
});

test('enabled queue accepts a read-only task, supports idempotency, and returns it once to the worker', async () => {
  await withServer(async base => {
    const first = await fetch(base + '/api/task', {
      method: 'POST',
      headers: { ...userHeaders, 'Idempotency-Key': 'safe-read-001' },
      body: JSON.stringify({ task: 'Read the public page title', mode: 'read_only' })
    });
    assert.equal(first.status, 202);
    const created = await first.json();
    assert.equal(created.status, 'queued');
    assert.equal(created.mode, 'read_only');

    const duplicate = await fetch(base + '/api/task', {
      method: 'POST',
      headers: { ...userHeaders, 'Idempotency-Key': 'safe-read-001' },
      body: JSON.stringify({ task: 'Read the public page title', mode: 'read_only' })
    });
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json()).id, created.id);

    const claim = await fetch(base + '/api/worker/claim', {
      method: 'POST', headers: workerHeaders, body: '{}'
    });
    assert.equal(claim.status, 200);
    const claimed = (await claim.json()).task;
    assert.equal(claimed.id, created.id);
    assert.equal(claimed.task, 'Read the public page title');

    const emptyClaim = await fetch(base + '/api/worker/claim', {
      method: 'POST', headers: workerHeaders, body: '{}'
    });
    assert.equal((await emptyClaim.json()).task, null);

    const result = await fetch(base + '/api/worker/result', {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({ id: created.id, status: 'completed', result: 'Page title: Example' })
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).status, 'completed');
  }, { workerProtocolEnabled: true });
});

test('worker cannot complete unknown or unclaimed tasks and results are size-limited', async () => {
  await withServer(async base => {
    const unknown = await fetch(base + '/api/worker/result', {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({ id: 'unknown', status: 'completed', result: 'ok' })
    });
    assert.equal(unknown.status, 404);

    const taskResponse = await fetch(base + '/api/task', {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ task: 'Read a public page' })
    });
    const task = await taskResponse.json();

    const claim = await fetch(base + '/api/worker/claim', {
      method: 'POST', headers: workerHeaders, body: '{}'
    });
    assert.equal((await claim.json()).task.id, task.id);

    const tooLarge = await fetch(base + '/api/worker/result', {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({ id: task.id, status: 'completed', result: 'x'.repeat(4001) })
    });
    assert.equal(tooLarge.status, 400, 'worker results must be size-limited');
  }, { workerProtocolEnabled: true });
});
