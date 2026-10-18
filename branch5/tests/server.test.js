import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, validateTask } from '../server.js';

const TOKEN = 'test-token-that-is-long-enough-for-test-only';

async function withServer(fn, options = {}) {
  const server = createServer({ token: TOKEN, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('health endpoint is public and reports this is only a PoC', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/health');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.service, 'branch5-poc');
    assert.equal(body.adapterReady, false);
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

test('safe read-only task fails closed without a verified browser adapter', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/api/task', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
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
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: '{invalid'
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_json' });
  });
});
