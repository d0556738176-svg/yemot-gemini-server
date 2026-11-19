import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ext5Layout, setupExt5, EXT5_MARK } from '../tv-ext5.js';
import { targetDay, filesForHour, hoursAvailable, israelParts } from '../tv-recorder.js';

test('extension 5: menu, every channel its own extension, replays in 5/9', () => {
  const l = ext5Layout('https://ext2.example/');
  const paths = l.map(x => x[0]);
  assert.equal(paths[0], 'ivr2:/5');
  assert.ok(paths.includes('ivr2:/5/1') && paths.includes('ivr2:/5/8') && paths.includes('ivr2:/5/9') && paths.includes('ivr2:/5/9/3'));
  const one = Object.fromEntries(l);
  assert.match(one['ivr2:/5/1'], /^type=api\napi_link=https:\/\/ext2\.example\/yemot-youtube\napi_add_0=tv=live1\ntitle=כאן 11\next5_tv=yes\n$/);
  assert.match(one['ivr2:/5/9/2'], /api_add_0=tv=replay2/);
  assert.ok(l.every(([, ini]) => ini.includes(EXT5_MARK)));
});

test('extension 5 setup: writes, reads back, leaves equal folders alone', async () => {
  const store = { 'ivr2:/5/ext.ini': 'type=playfile\ntitle=הורדות שמע מכל האתרים\next5_web_audio_library=yes\n' };
  const puts = [];
  const io = { getText: async w => store[w] ?? null, putText: async (w, c) => { puts.push(w); store[w] = c; } };
  const st = await setupExt5('https://x.example', io, { info() {} });
  assert.ok(st.folders.every(f => f.ok));
  assert.equal(st.folders[0].before, 'type=playfile');
  const n = puts.length; puts.length = 0;
  await setupExt5('https://x.example', io, { info() {} });
  assert.equal(puts.length, 0, 'nothing rewritten the second time');
  assert.ok(n >= 18);
});

test('replay hours: the latest occurrence of the hour, in Israel time', async () => {
  const now = new Date('2026-11-19T20:30:00Z'); // 22:30 in Israel
  assert.equal(israelParts(now).hour, 22);
  assert.equal(targetDay(21, now), '20261119');
  assert.equal(targetDay(23, now), '20261118');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  mkdirSync(path.join(dir, '1'));
  for (const n of ['20261119-210000.mp3', '20261119-211000.mp3', '20261118-230000.mp3', '20261118-210000.mp3', '20261119-220000.mp3'])
    writeFileSync(path.join(dir, '1', n), 'x');
  const f = await filesForHour('1', 21, now, dir);
  assert.deepEqual(f.map(x => path.basename(x)), ['20261119-210000.mp3', '20261119-211000.mp3']);
  assert.deepEqual(await hoursAvailable('1', now, dir), [21, 22, 23]);
});

test('replay hour folder: extension 7 keys, 0 = back to the hours, # = main menu', async () => {
  const { hourIni, hourFolder } = await import('../tv-replay-folder.js');
  const ini = hourIni('2', 'ערוץ 12', 22);
  assert.equal(hourFolder('2', 8), 'ivr2:/5/9/2/08');
  for (const line of ['type=playfile', 'start=min', 'control_play1=seconds_plus', 'control_play3=seconds_minus', 'control_play4=minus', 'control_play5=wait',
    'control_play6=plus', 'control_play7=minut_plus_amount1', 'minut_plus_amount1=180000', 'control_play0=go_to_folder',
    'playfile_control_play_0_goto=/5/9/2', 'control_play#=go_to_folder', 'playfile_control_play_#_goto=/'])
    assert.ok(ini.split('\n').includes(line), line);
  assert.ok(!/control_play8|control_play9|start=max/.test(ini), 'no file details, dubbing or newest-first order');
});
