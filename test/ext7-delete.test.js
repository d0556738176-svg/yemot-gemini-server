import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteFromAll, belongs, cacheDirOf, INDEX, OWNERS } from '../ext7-delete.js';
import { handleMediaKey } from '../branch2-media-keys.js';

function fake() {
  const files = new Set([
    'ivr2:/7/010.wav', 'ivr2:/7/011.wav', 'ivr2:/7/012.wav', 'ivr2:/7/013.wav',
    'ivr2:/אודיו/שיר_יפה__Shir_Yafe.flac', 'ivr2:/אודיו_2/שיר_יפה__Shir_Yafe.mp3', 'ivr2:/אודיו/אחר.flac',
    'ivr2:/וידאו/שיר_יפה__Shir_Yafe.mp4', 'ivr2:/וידאו/אחר.mp4',
    'ivr2:/אודיו/ארוך_Chelek_1.m4a', 'ivr2:/אודיו/ארוך_Chelek_2.m4a',
    'ivr2:/שירי AI/שיר הים - abc123.flac', 'ivr2:/אודיו/שיר AI - שיר הים - abc123.mp3', 'ivr2:/שירי AI/שיר אחר - zzz999.flac',
  ]);
  const dirs = new Set([cacheDirOf('AAAAAAAAAAA'), cacheDirOf('LLLLLLLLLLL')]);
  const json = new Map([[INDEX, { next: 14, items: {
    AAAAAAAAAAA: { file: '011', title: 'שיר יפה' }, 'AAAAAAAAAAA-he': { file: '012', title: 'מדובב' },
    LLLLLLLLLLL: { file: '010', title: 'ארוך' }, 'ai-song-abc123def': { file: '013', title: 'שיר AI: שיר הים' } } }],
    [OWNERS, { 'שיר_יפה__Shir_Yafe': 'AAAAAAAAAAA', 'אחר': 'BBBBBBBBBBB', 'ארוך': 'LLLLLLLLLLL' }]]);
  let refreshed = 0;
  return { files, dirs, json, get refreshed() { return refreshed; },
    readJson: async x => structuredClone(json.get(x)), writeJson: async (x, d) => { json.set(x, structuredClone(d)); },
    del: async w => { if (!files.delete(w)) throw new Error('missing ' + w); },
    delDir: async w => { if (!dirs.delete(w)) throw new Error('no dir'); },
    list: async dir => { const pre = dir + '/'; const out = [...files].filter(f => f.startsWith(pre) && !f.slice(pre.length).includes('/')).map(f => f.slice(pre.length)); return out.length || dir === 'ivr2:/7' ? out : (['ivr2:/אודיו', 'ivr2:/וידאו', 'ivr2:/שירי AI'].includes(dir) ? [] : null); },
    refreshAi: async () => { refreshed++; } };
}

test('a downloaded song: 7, the list, the saved copy, the audio and video copies, the owners line; the dub stays', async () => {
  const io = fake();
  const r = await deleteFromAll('/7', '011', io, {});
  assert.ok(!io.files.has('ivr2:/7/011.wav'));
  assert.ok(!io.json.get(INDEX).items.AAAAAAAAAAA);
  assert.ok(io.json.get(INDEX).items['AAAAAAAAAAA-he'], 'the Hebrew-dubbed file is separate and stays');
  assert.ok(io.files.has('ivr2:/7/012.wav'));
  assert.ok(!io.dirs.has(cacheDirOf('AAAAAAAAAAA')));
  for (const f of ['ivr2:/אודיו/שיר_יפה__Shir_Yafe.flac', 'ivr2:/אודיו_2/שיר_יפה__Shir_Yafe.mp3', 'ivr2:/וידאו/שיר_יפה__Shir_Yafe.mp4']) assert.ok(!io.files.has(f), f);
  assert.ok(io.files.has('ivr2:/אודיו/אחר.flac') && io.files.has('ivr2:/וידאו/אחר.mp4'), 'other songs untouched');
  assert.ok(!('שיר_יפה__Shir_Yafe' in io.json.get(OWNERS)));
  assert.equal(io.refreshed, 1);
  assert.equal(r.next, '010');
});

test('a long song saved in parts loses every part; an AI song loses its "שירי AI" and audio copies', async () => {
  const io = fake();
  await deleteFromAll('/7', '010', io, {});
  assert.ok(!io.files.has('ivr2:/אודיו/ארוך_Chelek_1.m4a') && !io.files.has('ivr2:/אודיו/ארוך_Chelek_2.m4a'));
  const r = await deleteFromAll('/7', '013', io, {});
  assert.ok(!io.files.has('ivr2:/שירי AI/שיר הים - abc123.flac'));
  assert.ok(!io.files.has('ivr2:/אודיו/שיר AI - שיר הים - abc123.mp3'));
  assert.ok(io.files.has('ivr2:/שירי AI/שיר אחר - zzz999.flac'));
  assert.equal(r.next, '012');
});

test('key 2 in 7: asks "from the whole system", 2 cancels, 1 deletes', async () => {
  const io = fake();
  const deps = { lookup: async () => ({ videoId: 'AAAAAAAAAAA', title: 'x' }), canDelete: d => d === '/7',
    deleteQuestion: () => ['האם למחוק את הקובץ מכל המערכת'],
    deleteFile: async (d, f) => ({ ...(await deleteFromAll(d, f, io, {})), spoken: 'הקובץ נמחק מכל המערכת' }) };
  const ask = await handleMediaKey({ what: 'ivr2:/7/011.wav', PlayStop: '3000', PressKey: '2' }, deps, {});
  assert.match(ask, /^read=t-האם למחוק את הקובץ מכל המערכת\.t-למחיקה הקש 1\.t-לביטול הקש 2=del_ok,/);
  const no = await handleMediaKey({ what: 'ivr2:/7/011.wav', PlayStop: '3000', PressKey: '2', del_ok: '2' }, deps, {});
  assert.equal(no, 'id_list_message=t-בוטל ממשיכים בהשמעה&go_to_folder_and_play=/7,011,3000');
  assert.ok(io.files.has('ivr2:/7/011.wav'));
  const yes = await handleMediaKey({ what: 'ivr2:/7/011.wav', PlayStop: '3000', PressKey: '2', del_ok: '1' }, deps, { info() {} });
  assert.match(yes, /הקובץ נמחק מכל המערכת.*&go_to_folder_and_play=\/7,010,0$/);
  assert.ok(!io.files.has('ivr2:/7/011.wav'));
});

test('name matching', () => {
  assert.ok(belongs('שיר_יפה__Shir_Yafe.flac', ['שיר_יפה__Shir_Yafe']));
  assert.ok(belongs('שיר_יפה_חלק_2__Shir_Yafe_Chelek_2.m4a', ['שיר_יפה__Shir_Yafe']));
  assert.ok(!belongs('שיר_יפה__Shir_Yafe_2.flac', ['שיר_יפה__Shir_Yafe']));
});
