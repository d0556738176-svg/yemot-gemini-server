import test from 'node:test';
import assert from 'node:assert/strict';
import { argsFor, parseProgress, formatFor, directEnabled, directDownload } from './youtube-direct.js';

test('progress line is read in bytes', () => {
  assert.deepEqual(parseProgress('[download]  50.0% of   10.00MiB at 1.00MiB/s ETA 00:05'), { done: 5242880, total: 10485760 });
  assert.equal(parseProgress('[youtube] abc: Downloading webpage'), null);
});
test('audio and video arguments', () => {
  const a = argsFor('jNQXAC9IVRw', '/tmp/x', { client: 'tv,web_safari' });
  assert.ok(a.includes('youtube:player_client=tv,web_safari'));
  assert.equal(a.at(-1), 'jNQXAC9IVRw');
  assert.match(formatFor('video', 480), /height<=480/);
  assert.ok(argsFor('jNQXAC9IVRw', '/tmp/x', { mode: 'video' }).includes('--merge-output-format'));
});
test('can be turned off', () => {
  assert.equal(directEnabled({ YOUTUBE_DIRECT: 'off' }), false);
  assert.equal(directEnabled({}), true);
});
test('every player type failing throws so the engine is used', async () => {
  await assert.rejects(directDownload('jNQXAC9IVRw', '/tmp/direct-test-x', { bin: '/bin/false', log: {} }), /exit|failed/);
});
