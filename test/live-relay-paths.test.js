import test from 'node:test';
import assert from 'node:assert/strict';

// 23.11: a '-' in the live folder name made every piece unplayable on the
// phone (Yemot reads '-' and '.' in a play list as separators).
test('live pieces are played from paths of letters, digits and slashes only', async () => {
  const L = await import('../live-relay.js');
  const a = L.runName('lc4a5348b0f'), b = L.runName('lc4a5348b0f', Date.now() + 5000);
  assert.notEqual(a, b, 'every run its own folder');
  const play = L.piecePath(a, '000.wav').replace(/\.wav$/, '');
  assert.match(play, /^[A-Za-z0-9/]+$/);
  assert.match(L.runName('a-b.c'), /^[A-Za-z0-9]+$/);
});
