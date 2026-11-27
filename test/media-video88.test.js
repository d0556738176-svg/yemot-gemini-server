// Owner, 27.11: in every folder of extension 11, 8 then 8 again saves the
// video to the video folder, asking with / without Hebrew subtitles first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMediaKey } from '../branch2-media-keys.js';

const mk = (extra = {}) => {
  const started = [];
  return { started, deps: {
    lookup: async (dir, file) => (dir.startsWith('/11/') ? { videoId: 'abc123def45', title: 'שיעור', channel: 'ערוץ' } : null),
    details: async () => ['שם הקובץ: שיעור'],
    canVideo: dir => dir.startsWith('/11/'),
    videoGate: async () => null,
    startVideo: v => { started.push(v); return { status: 'running' }; },
    ...extra } };
};
const q = (o) => ({ what: 'ivr2:/11/1/2/005.wav', PlayStop: '9000', ...o });

test('8 says the details and offers 8 again; the second 8 asks about subtitles', async () => {
  const { deps } = mk();
  const first = await handleMediaKey(q({ PressKey: '8' }), deps, { info() {} });
  assert.match(first, /להורדת הקובץ כסרטון לתיקיית וידאו הקש 8/);
  const second = await handleMediaKey(q({ PressKey: '8', skip8: '8' }), deps, { info() {} });
  assert.match(second, /^read=.*עם כתובית בעברית הקש 1.*בלי כתובית הקש 2.*=vid_sub,/);
  const other = await handleMediaKey(q({ PressKey: '8', skip8: '5' }), deps, { info() {} });
  assert.match(other, /^go_to_folder_and_play=\/11\/1\/2,005,9000$/);
});

test('1 = with subtitles, 2 = without; the job starts and playback goes on', async () => {
  for (const [k, subs] of [['1', true], ['2', false]]) {
    const { deps, started } = mk();
    const out = await handleMediaKey(q({ PressKey: '8', skip8: '8', vid_sub: k }), deps, { info() {} });
    assert.equal(started.length, 1); assert.equal(started[0].subtitles, subs); assert.equal(started[0].videoId, 'abc123def45');
    assert.match(out, /הורדת הסרטון התחילה/); assert.match(out, /go_to_folder_and_play=\/11\/1\/2,005,9000$/);
  }
  const { deps, started } = mk();
  const cancel = await handleMediaKey(q({ PressKey: '8', skip8: '8', vid_sub: '0' }), deps, { info() {} });
  assert.equal(started.length, 0); assert.match(cancel, /בוטל/);
});

test('when the free download is not possible, the paid engine only after another 1', async () => {
  const { deps, started } = mk({ videoGate: async () => ({ ask: 'paid', prompt: 'להורדה במנוע הגיבוי הקש 1, לביטול הקש 2.' }) });
  const ask = await handleMediaKey(q({ PressKey: '8', skip8: '8', vid_sub: '2' }), deps, { info() {} });
  assert.match(ask, /=vid_ok,/); assert.equal(started.length, 0);
  await handleMediaKey(q({ PressKey: '8', skip8: '8', vid_sub: '2', vid_ok: '1' }), deps, { info() {} });
  assert.equal(started.length, 1); assert.equal(started[0].paidConsent, true);
});

test('outside extension 11 the second 8 does nothing new', async () => {
  const { deps } = mk({ lookup: async () => ({ videoId: 'x', title: 't' }) });
  const out = await handleMediaKey({ what: 'ivr2:/7/003.wav', PlayStop: '1000', PressKey: '8', skip8: '8' }, deps, { info() {} });
  assert.match(out, /^go_to_folder_and_play=\/7,003,1000$/);
});
