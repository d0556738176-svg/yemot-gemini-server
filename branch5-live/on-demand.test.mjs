import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { channel12, createOnDemand, createExtensionGate, validateSource } from './on-demand.mjs';
const source = channel12.candidate;

test('nothing starts before a valid call; missing source fails closed', () => {
  let starts = 0;
  const e = createOnDemand({ source, publish: async () => {}, capture: async () => { starts++; } });
  assert.equal(e.activeSessions, 0); assert.equal(starts, 0);
  assert.throws(() => e.enter(''), /CALL_ID_REQUIRED/);
  assert.throws(() => createOnDemand({ publish() {} }).enter('call'), /SOURCE_NOT_CONFIGURED/);
  e.close();
});
test('callback retries reuse in-flight and completed chunks', async () => {
  let count = 0;
  const e = createOnDemand({ source, capture: async () => { count++; await delay(15); },
    publish: async ({ sequence }) => 'path-' + sequence });
  e.enter('call'); const a = e.next('call', 0); const b = e.next('call', 0);
  assert.equal(a, b); assert.equal(await a, 'path-0');
  assert.equal(await e.next('call', 0), 'path-0'); assert.equal(count, 1);
  await assert.rejects(e.next('call', 3), /BAD_SEQUENCE/);
  e.close();
});
test('hangup cancels capture and prevents upload', async () => {
  let published = false;
  const e = createOnDemand({ source,
    capture: async ({ signal }) => { await delay(100, undefined, { signal }); },
    publish: async () => { published = true; } });
  e.enter('call'); const p = e.next('call', 0); e.stop('call');
  await assert.rejects(p); assert.equal(published, false); assert.equal(e.activeSessions, 0);
});
test('idle expiry and concurrency limit bound abandoned calls', async () => {
  const e = createOnDemand({ source, publish() {}, idleMs: 15, maxSessions: 1 });
  e.enter('one'); assert.throws(() => e.enter('two'), /BUSY/);
  await delay(40); assert.equal(e.activeSessions, 0); e.close();
});
test('capture failure removes the session; no false playback success', async () => {
  const e = createOnDemand({ source, publish() { assert.fail(); },
    capture: async () => { throw new Error('SOURCE_UNAVAILABLE'); } });
  e.enter('call'); await assert.rejects(e.next('call', 0), /SOURCE_UNAVAILABLE/);
  assert.equal(e.activeSessions, 0); e.close();
});
test('untrusted or credential-bearing source URLs are rejected', () => {
  for (const u of ['http://localhost/x', 'https://evil.example/x', 'https://user:pw@mako-streaming.akamaized.net/x']) {
    assert.throws(() => validateSource(u), /SOURCE_NOT_ALLOWED/);
  }
});

test('old cancelled work cannot stop a new session with the same call id', async () => {
  let started;
  const ready = new Promise(r => { started = r; });
  const e = createOnDemand({ source, capture: async ({ signal }) => {
    started(); await delay(20); signal.throwIfAborted();
  }, publish: async () => 'ok' });
  e.enter('call'); const old = e.next('call', 0); await ready;
  e.stop('call'); e.enter('call');
  await assert.rejects(old); assert.equal(e.activeSessions, 1);
  assert.equal(await e.next('call', 0), 'ok'); e.close();
});

test('only exact /5/1 starts work; parent menu never starts capture', async () => {
  let captures = 0;
  const e = createOnDemand({ source, capture: async () => { captures++; }, publish: async () => 'ok' });
  const gate = createExtensionGate(e);
  for (const folder of ['/5', '/1', '/5/10', '/5/2']) {
    assert.deepEqual(await gate({ callId: 'call', folder }), { stopped: true });
  }
  assert.equal(captures, 0);
  assert.equal(await gate({ callId: 'call', folder: '/5/1' }), 'ok');
  assert.equal(captures, 1);
  await gate({ callId: 'call', folder: '/5', event: 'exit' });
  assert.equal(e.activeSessions, 0); e.close();
});

test('hangup and exit are processed before sequence or capture', async () => {
  const e = createOnDemand({ source, publish() { assert.fail(); } });
  const gate = createExtensionGate(e);
  e.enter('call');
  await gate({ callId: 'call', folder: '/5/1', event: 'hangup', sequence: 999 });
  assert.equal(e.activeSessions, 0);
  await assert.rejects(gate({ callId: '', folder: '/5/1' }), /CALL_ID_REQUIRED/);
  await assert.rejects(gate({ callId: 'call', folder: '/5/1', sequence: 5 }), /BAD_SEQUENCE/);
  assert.equal(e.activeSessions, 0); e.close();
});
