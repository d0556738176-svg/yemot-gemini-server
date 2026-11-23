import test from 'node:test';
import assert from 'node:assert/strict';

// 23.11: a '-' in the live folder name made every piece unplayable on the
// phone. The folder is the channel's own (as it worked before); each run has
// its own file names, digits only.
test('live pieces: the channel folder, digit-only file names, a new name per run', async () => {
  const L = await import('../live-relay.js');
  const a = L.runTag(1000000123456), b = L.runTag(1000000999999);
  assert.match(a, /^\d{6}$/); assert.notEqual(a, b);
  const play = L.piecePath('lc4a5348b0f', a, '000.wav').replace(/\.wav$/, '');
  assert.equal(play, '/2/live/lc4a5348b0f/123456/000');
  assert.match(play, /^\/2\/live\/[A-Za-z0-9]+\/\d{6}\/\d{3}$/);
});
