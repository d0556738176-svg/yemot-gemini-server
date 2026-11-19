import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'rec-'));
process.env.TV_REC_DIR = dir;
const mp3 = (key, name) => { mkdirSync(path.join(dir, key), { recursive: true }); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=4', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', path.join(dir, key, name)]); };

test('every finished hour goes to Yemot as one file, a new number each day, kept for good', async () => {
  const RF = await import('../tv-replay-folder.js');
  // Two days of 21:00 (finished), and the current hour (still recording: not published).
  mp3('1', '20261118-210000.mp3'); mp3('1', '20261118-211000.mp3');
  mp3('1', '20261119-210000.mp3');
  const now = new Date('2026-11-19T20:30:00Z'); // 22:30 in Israel
  mp3('1', '20261119-220000.mp3');
  const ch = { key: '1', title: 'כאן 11' };
  const todo = await RF.hoursToPublish([ch], now);
  assert.deepEqual(todo.map(x => x.id), ['20261118-21', '20261119-21']);
  assert.equal(todo[0].files.length, 2);

  const yemot = { 'ivr2:/5/9/1/21/000.wav': 'left from the old layout' }; const order = []; const deleted = [];
  const io = {
    list: async f => ({ files: Object.keys(yemot).filter(k => k.startsWith(f + '/') && k.endsWith('.wav')).map(k => ({ name: k.split('/').pop() })) }),
    del: async r => { deleted.push(r); delete yemot[r]; },
    putText: async (w, c) => { order.push('settings'); yemot[w] = c; },
    // A big file is moved into its folder at the end: the folder must exist.
    upload: async (f, r) => { if (!yemot[r.replace(/[^/]+$/, 'ext.ini')]) throw new Error('folder missing'); order.push('upload ' + r.split('/').slice(-1)[0]); yemot[r] = 'audio'; },
    getText: async w => yemot[w] ?? null,
    log: { info() {}, warn() {} },
  };
  for (const item of todo) await RF.publishHour(item, io);
  assert.deepEqual(deleted, ['ivr2:/5/9/1/21/000.wav'], 'old layout cleared once');
  assert.deepEqual(order, ['settings', 'upload 000.wav', 'upload 001.wav'], 'settings create the folder; day 1 = 000, day 2 = 001 (newest first with start=max)');
  assert.match(yemot['ivr2:/5/9/1/21/ext.ini'], /\nstart=max\n/);
  assert.deepEqual(RF.publishedHours('1'), [21]);
  assert.deepEqual((await RF.hoursToPublish([ch], now)).map(x => x.id), [], 'nothing published twice');
  assert.equal(RF.replayLog[0].ok, true);
});
