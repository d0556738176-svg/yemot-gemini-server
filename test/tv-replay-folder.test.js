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

test('the hours of a channel can be made again in place: same file number, nothing new added', async () => {
  const RF = await import('../tv-replay-folder.js');
  const now = new Date('2026-11-19T20:30:00Z');
  const ch = { key: '1', title: 'כאן 11' };
  const yemot = { 'ivr2:/5/9/1/21/000.wav': 'old', 'ivr2:/5/9/1/21/001.wav': 'old' }; const deleted = [];
  const io = {
    list: async () => ({ files: [] }), del: async r => { deleted.push(r); delete yemot[r]; },
    putText: async (w, c) => { yemot[w] = c; }, getText: async w => yemot[w] ?? null,
    upload: async (f, r) => { if (yemot[r]) throw new Error('old file still in place'); yemot[r] = 'new'; },
    log: { info() {}, warn() {} },
  };
  yemot['ivr2:/5/9/1/21/ext.ini'] = RF.hourIni('1', 'כאן 11', 21);
  assert.equal(await RF.markRedo('1'), 2);
  const todo = await RF.hoursToPublish([ch], now);
  assert.deepEqual(todo.map(x => x.id + '>' + x.number), ['20261118-21>000', '20261119-21>001']);
  for (const item of todo) await RF.publishHour(item, io);
  assert.equal(yemot['ivr2:/5/9/1/21/000.wav'], 'new'); assert.equal(yemot['ivr2:/5/9/1/21/001.wav'], 'new');
  assert.ok(!('ivr2:/5/9/1/21/002.wav' in yemot), 'no new number');
  assert.deepEqual((await RF.hoursToPublish([ch], now)).map(x => x.id), [], 'done once');
  mp3('1', '20261119-230000.mp3');
  const later = await RF.hoursToPublish([ch], new Date('2026-11-20T08:00:00Z'));
  assert.deepEqual(later.map(x => x.id), ['20261119-22', '20261119-23'], 'new hours still get new numbers');
});

test('one hour that fails does not hold up the other channels', async () => {
  const RF = await import('../tv-replay-folder.js');
  mp3('5', '20261119-100000.mp3'); mp3('6', '20261119-100000.mp3');
  const chs = [{ key: '5', title: 'a' }, { key: '6', title: 'b' }];
  const yemot = {}; const tried = [];
  const io = { list: async () => ({ files: [] }), del: async () => {}, putText: async (w, c) => { yemot[w] = c; }, getText: async w => yemot[w] ?? null,
    upload: async (f, r) => { tried.push(r); if (r.includes('/5/9/5/')) throw new Error('WS name is not allowed'); yemot[r] = 'x'; }, log: { info() {}, warn() {} } };
  const n = await RF.publishPending(chs, io);
  assert.equal(n, 1, 'channel 6 published although channel 5 failed');
  assert.ok(yemot['ivr2:/5/9/6/10/000.wav']);
  const before = tried.length;
  await RF.publishPending(chs, io);
  assert.equal(tried.filter(r => r.includes('/5/9/5/')).length, tried.slice(0, before).filter(r => r.includes('/5/9/5/')).length, 'the failed hour waits before the next try');
});
