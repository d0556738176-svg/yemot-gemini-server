import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'rec-'));
process.env.TV_REC_DIR = dir;

test('replay hour: files first, then the settings (Yemot refuses settings for an empty folder)', async () => {
  const { prepareHour, replayLog } = await import('../tv-replay-folder.js');
  const { israelParts } = await import('../tv-recorder.js');
  const now = israelParts();
  mkdirSync(path.join(dir, '1'), { recursive: true });
  const hh = String(now.hour).padStart(2, '0');
  for (const m of ['00', '10']) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=5', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', path.join(dir, '1', now.ymd + '-' + hh + m + '00.mp3')]);
  const yemot = {}; const order = [];
  const io = {
    upload: async (f, r) => { order.push('upload ' + path.basename(r)); yemot[r] = 'audio'; },
    putText: async (w, c) => { if (!Object.keys(yemot).some(k => k.startsWith(w.replace('/ext.ini', '/')))) throw new Error('folder missing'); order.push('settings'); yemot[w] = c; },
    getText: async w => yemot[w] ?? null,
    del: async () => {}, log: { info() {} },
  };
  const folder = await prepareHour({ key: '1', title: 'כאן 11' }, now.hour, io).done;
  assert.equal(folder, '/5/9/1/' + hh);
  // The two parts upload side by side (either may finish first); the settings come last.
  assert.deepEqual(order.slice(0, 2).sort(), ['upload 000.wav', 'upload 001.wav']);
  assert.equal(order[2], 'settings');
  assert.match(yemot['ivr2:/5/9/1/' + hh + '/ext.ini'], /^type=playfile\n.*\nstart=min\n/);
  assert.equal(replayLog[0].ok, true);
  // Second time: nothing uploaded again.
  order.length = 0;
  await prepareHour({ key: '1', title: 'כאן 11' }, now.hour, io).done.catch(() => {});
  await new Promise(r => setTimeout(r, 5200)); // the job of the first call is released after 5 s
  await prepareHour({ key: '1', title: 'כאן 11' }, now.hour, io).done;
  assert.ok(!order.some(x => x.startsWith('upload')), 'unchanged files are not uploaded again: ' + order.join(','));
});
