import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMediaKey, parseWhat, backTo } from './branch2-media-keys.js';
import { groupSentences } from './youtube-dub.js';

const deps = (over = {}) => ({
  lookup: async (dir, file) => (file === '005' ? { videoId: 'abcdefghijk', title: 'How it works', dub: false } : file === '006' ? { videoId: 'abcdefghijk', title: 'x', dub: true } : null),
  details: async () => ['שם הקובץ: איך זה עובד', 'אורך: 3 דקות'],
  dubStatus: async () => null,
  startDub: () => ({ status: 'running' }),
  language: async () => ({ code: 'en', name: 'אנגלית' }),
  ...over,
});

test('the playing file and position are parsed and playback resumes there', () => {
  assert.deepEqual(parseWhat('ivr2:/7/005.wav'), { dir: '/7', file: '005' });
  assert.equal(backTo('ivr2:/7/005.wav', '83250'), 'go_to_folder_and_play=/7,005,83250');
});

test('key 8 speaks the details and returns to the same place', async () => {
  const r = await handleMediaKey({ what: 'ivr2:/7/005.wav', PlayStop: '1000', PressKey: '8' }, deps(), {});
  assert.match(r, /^id_list_message=t-שם הקובץ: איך זה עובד\.t-אורך: 3 דקות\.t-ממשיכים בהשמעה&go_to_folder_and_play=\/7,005,1000$/);
});

test('key 9 asks 1/2 first; 1 starts the dubbing, 2 cancels', async () => {
  const ask = await handleMediaKey({ what: 'ivr2:/7/005.wav', PressKey: '9' }, deps(), {});
  assert.match(ask, /^read=t-הקובץ הזה באנגלית\.t-האם לתרגם את הקובץ לדיבוב בעברית\.t-לאישור הקש 1\.t-לביטול הקש 2=dub_ok,no,1,1,10,No,yes,no,,1\.2,1,Ok,2,$/);
  let started = 0;
  const yes = await handleMediaKey({ what: 'ivr2:/7/005.wav', PressKey: '9', dub_ok: '1', PlayStop: '5' }, deps({ startDub: () => { started++; return { status: 'running' }; } }), {});
  assert.equal(started, 1);
  assert.match(yes, /הדיבוב לעברית התחיל.*&go_to_folder_and_play=\/7,005,5$/);
  const no = await handleMediaKey({ what: 'ivr2:/7/005.wav', PressKey: '9', dub_ok: '2' }, deps({ startDub: () => { throw new Error('must not start'); } }), {});
  assert.match(no, /בוטל/);
});

test('a dubbed file is not dubbed again; an existing dub is pointed to', async () => {
  assert.match(await handleMediaKey({ what: 'ivr2:/7/006.wav', PressKey: '9' }, deps(), {}), /כבר מדובב/);
  assert.match(await handleMediaKey({ what: 'ivr2:/7/005.wav', PressKey: '9' }, deps({ dubStatus: async () => ({ state: 'done', file: '012' }) }), {}), /בקובץ מספר 12/);
});

test('sentences are grouped by pauses and sentence ends', () => {
  const g = groupSentences([{ start: 0, end: 1, text: 'Hello' }, { start: 1.1, end: 2.5, text: 'world.' }, { start: 2.6, end: 3, text: 'Next' }, { start: 5, end: 6, text: 'after pause' }]);
  assert.deepEqual(g.map(x => x.text), ['Hello world.', 'Next', 'after pause']);
});
