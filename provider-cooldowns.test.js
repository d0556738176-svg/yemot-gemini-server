import test from 'node:test';
import assert from 'node:assert/strict';
import { createCooldownRegistry } from './provider-cooldowns.js';

test('quota errors open a longer cooldown than transient errors', () => {
  let now = 1000;
  const gate = createCooldownRegistry({ quotaMs: 90000, transientMs: 25000, now: () => now });
  assert.equal(gate.cool('primary', 429), 90000);
  assert.equal(gate.isCoolingDown('primary'), true);
  assert.equal(gate.remainingMs('primary'), 90000);
  assert.equal(gate.cool('backup-model', 503), 25000);
  assert.equal(gate.remainingMs('backup-model'), 25000);
});

test('cooldowns expire without a background timer', () => {
  let now = 5000;
  const gate = createCooldownRegistry({ quotaMs: 90000, transientMs: 25000, now: () => now });
  gate.cool('model', 429);
  now += 90001;
  assert.equal(gate.isCoolingDown('model'), false);
  assert.equal(gate.remainingMs('model'), 0);
});

test('successful provider response clears only its own circuit', () => {
  const gate = createCooldownRegistry();
  gate.cool('primary', 503);
  gate.cool('backup', 429);
  gate.clear('primary');
  assert.equal(gate.isCoolingDown('primary'), false);
  assert.equal(gate.isCoolingDown('backup'), true);
});

test('non-retryable errors do not open a cooldown', () => {
  const gate = createCooldownRegistry();
  assert.equal(gate.cool('primary', 401), 0);
  assert.equal(gate.isCoolingDown('primary'), false);
});
