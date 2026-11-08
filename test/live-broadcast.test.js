import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChannels, isOn, remainingSeconds } from '../live-broadcast.js';

test('parses channel lines and skips bad ones', () => {
  const c = parseChannels('1=StreamA=ערוץ ראשון\n# note\n0=bad\n2=StreamB\n1=dup;3=S3=שלישי');
  assert.deepEqual(c.map(x => x.key), ['1', '2', '3']);
  assert.equal(c[0].name, 'StreamA');
  assert.equal(c[1].title, 'ערוץ 2');
});

test('on/off and auto-off timer', () => {
  const now = 1_000_000;
  assert.equal(isOn({ on: false }, now), false);
  assert.equal(isOn({ on: true, until: 0 }, now), true);
  assert.equal(isOn({ on: true, until: now - 1 }, now), false);
  assert.equal(remainingSeconds({ on: true, until: now + 90_000 }, now), 90);
  assert.equal(remainingSeconds({ on: true, until: 0 }, now, 3600), 3600);
  assert.equal(remainingSeconds({ on: true, until: now - 5 }, now), 0);
});

test('always-on mode ignores the switch', () => {
  process.env.BRANCH5_ALWAYS_ON = 'true';
  try {
    assert.equal(isOn({ on: false }), true);
    assert.equal(remainingSeconds({ on: false, until: 5 }, 1000, 3600), 3600);
  } finally { delete process.env.BRANCH5_ALWAYS_ON; }
});
