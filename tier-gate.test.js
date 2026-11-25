import test from 'node:test';
import assert from 'node:assert/strict';
import { createTierGate } from './tier-gate.js';
const tick = () => new Promise(r => setImmediate(r));
test('the next group waits for the one before it to fail', async () => {
  const timers = []; const g = createTierGate([6500, 3500, 3000, 0], { setTimer: (fn, ms) => { timers.push({ fn, ms }); return {}; } });
  g.add(0); g.add(1); g.add(1); g.add(3); g.start(); await tick();
  assert.equal(g.isOpen(0), true); assert.equal(g.isOpen(1), false);
  assert.equal(timers[0].ms, 6500);
  g.fail(0); await tick();
  assert.equal(g.isOpen(1), true); assert.equal(g.isOpen(2), false);
  g.fail(1); assert.equal(g.isOpen(2), false); g.fail(1);
  // group 2 is empty: straight on to group 3
  assert.equal(g.isOpen(2), true); assert.equal(g.isOpen(3), true);
});
test('a slow group gives way after its time, an answer stops the rest', async () => {
  const timers = []; let done = false;
  const g = createTierGate([2000, 3500, 3000, 0], { isDone: () => done, setTimer: (fn, ms) => { timers.push({ fn, ms }); return {}; } });
  g.add(0); g.add(1); g.add(2); g.start();
  timers[0].fn(); assert.equal(g.isOpen(1), true); assert.equal(timers[1].ms, 3500);
  done = true; timers[1].fn(); assert.equal(g.isOpen(2), true);
  assert.equal(timers.length, 2); // nothing further was scheduled after the answer
});
test('with no Gemini the strong free model starts at once', () => {
  const g = createTierGate([6500, 3500, 3000, 0], { setTimer: () => ({}) });
  g.add(1); g.add(3); g.start();
  assert.equal(g.isOpen(1), true); assert.equal(g.isOpen(3), false);
});
