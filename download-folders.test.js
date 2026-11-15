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

test('the real file count in Yemot decides when a new folder opens', async () => {
  const { nextFolder } = await import('./download-folders.js');
  let saved = { audio: { n: 1, count: 30 } };
  const io = { readJson: async () => saved, writeJson: async (_, d) => { saved = d; } };
  const real = { 'ivr2:/אודיו': 2900, 'ivr2:/אודיו_2': 12 };
  assert.equal(await nextFolder('audio', { ...io, countFiles: async p => real[p] ?? 0 }), 'ivr2:/אודיו_2');
  assert.deepEqual(saved.audio, { n: 2, count: 12 });
  assert.equal(await nextFolder('audio', { ...io, countFiles: async () => null }), 'ivr2:/אודיו_2', 'Yemot not answering: the saved counter');
});
