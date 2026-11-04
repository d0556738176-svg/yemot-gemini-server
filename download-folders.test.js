import test from 'node:test';
import assert from 'node:assert/strict';
import { nextFolder, countSaved, FOLDER_LIMIT } from './download-folders.js';
test('a full folder continues in the next numbered folder', async () => {
  let data = null; const io = { readJson: async () => data, writeJson: async (_, d) => { data = d; } };
  assert.equal(await nextFolder('audio', io), 'ivr2:/אודיו');
  data = { audio: { n: 1, count: FOLDER_LIMIT } };
  assert.equal(await nextFolder('audio', io), 'ivr2:/אודיו_2');
  await countSaved('audio', io);
  assert.deepEqual(data.audio, { n: 2, count: 1 });
  assert.equal(await nextFolder('video', io), 'ivr2:/וידאו');
});
