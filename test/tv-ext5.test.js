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
  for (const line of ['type=playfile', 'start=max', 'control_play1=seconds_plus', 'control_play3=seconds_minus', 'control_play4=minus', 'control_play5=wait',
    'control_play6=plus', 'control_play7=minut_plus_amount1', 'minut_plus_amount1=180000', 'control_play0=go_to_folder',
    'playfile_control_play_0_goto=/5/9/2', 'control_play#=go_to_folder', 'playfile_control_play_#_goto=/'])
    assert.ok(ini.split('\n').includes(line), line);
  assert.ok(!/control_play8|control_play9|start=min/.test(ini), 'no file details or dubbing; newest day first');
});

test('extension 10: the radio list and one extension per station, in the owner order', async () => {
  const { ext5Layout } = await import('../tv-ext5.js');
  const { RADIO_CHANNELS } = await import('../branch2-tv.js');
  const lay = Object.fromEntries(ext5Layout('https://x.example'));
  assert.match(lay['ivr2:/10'], /api_add_0=tv=radio\n/);
  assert.deepEqual(RADIO_CHANNELS.map(c => c.digit), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(RADIO_CHANNELS[0].title, 'קול חי'); assert.equal(RADIO_CHANNELS[3].title, 'קול ברמה');
  for (const c of RADIO_CHANNELS) assert.match(lay['ivr2:/10/' + c.digit], new RegExp('api_add_0=tv=radio' + c.digit + '\\n'));
  assert.ok(!Object.keys(lay).some(k => k.startsWith('ivr2:/10/9')), 'no replays for radio');
});

test('main menu takes two digits; every other line kept; old settings saved once', async () => {
  const { setupMainMenu10, withTwoDigits } = await import('../tv-ext5.js');
  assert.equal(withTwoDigits('type=menu\r\nhash_extension=yes\ndigits=1\n'), 'type=menu\nhash_extension=yes\ndigits=2\ntimeout=2\ntext_extensions=yes\n');
  const files = { 'ivr2:/ext.ini': 'type=menu\nhash_extension=yes\ntitle=ראשי\n', 'ivr2:/ExtensionNumbersAndAssociations.ini': '55=/9\n' };
  const io = { getText: async w => files[w] ?? null, putText: async (w, c) => { files[w] = c; } };
  const st = await setupMainMenu10(io, { info() {} });
  assert.equal(st.ok, true);
  assert.equal(files['ivr2:/ext_before_10.ini'], 'type=menu\nhash_extension=yes\ntitle=ראשי\n');
  assert.match(files['ivr2:/ext.ini'], /^type=menu\nhash_extension=yes\ntitle=ראשי\ndigits=2\ntimeout=2\ntext_extensions=yes\n$/);
  assert.match(files['ivr2:/ExtensionNumbersAndAssociations.ini'], /^55=\/9\n00=0\n01=1\n/);
  files['ivr2:/ext.ini'] += 'x=1\n';
  await setupMainMenu10(io, { info() {} });
  assert.equal(files['ivr2:/ext_before_10.ini'], 'type=menu\nhash_extension=yes\ntitle=ראשי\n', 'backup kept from the first time');
  const other = { 'ivr2:/ext.ini': 'type=api\n' };
  const s2 = await setupMainMenu10({ getText: async w => other[w] ?? null, putText: async (w, c) => { other[w] = c; } }, { info() {} });
  assert.ok(s2.skipped); assert.equal(other['ivr2:/ext.ini'], 'type=api\n');
});
