import test from 'node:test';
import assert from 'node:assert/strict';
import { busy, waitForRoom } from './resource-guard.js';
test('busy when memory is short or the cores are overloaded', () => {
  assert.equal(busy({}, { availMB: 3000, load: 1, cpus: 2 }), false);
  assert.equal(busy({}, { availMB: 500, load: 0.2, cpus: 2 }), true);
  assert.equal(busy({}, { availMB: 3000, load: 3.5, cpus: 2 }), true);
});
test('waits while busy, then goes on', async () => {
  let n = 0;
  const roomFn = () => (++n < 3 ? { availMB: 100, load: 0, cpus: 2 } : { availMB: 3000, load: 0, cpus: 2 });
  await waitForRoom({ stepMs: 5, roomFn, log: {} });
  assert.ok(n >= 3);
});
test('never waits beyond the limit', async () => {
  const t = Date.now();
  await waitForRoom({ stepMs: 5, maxWaitMs: 40, roomFn: () => ({ availMB: 1, load: 9, cpus: 2 }), log: {} });
  assert.ok(Date.now() - t < 500);
});
