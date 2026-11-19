// Owner, 19.11: live broadcasts asked for in the AI extensions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveIntent } from '../live-intent.js';

test('a named channel goes straight to it', () => {
  assert.deepEqual(liveIntent('תשמיע לי את ערוץ 14 בשידור חי').tv.key, '4');
  assert.equal(liveIntent('אני רוצה לשמוע את כאן 11 עכשיו').tv.key, '1');
  assert.equal(liveIntent('תפתחי לי את רדיו 14').tv.key, '8');
  assert.equal(liveIntent('שידור חי של ערוץ הכנסת').tv.key, '6');
});
test('"what is live now" opens the channel menu', () => {
  assert.equal(liveIntent('מה משודר עכשיו בשידור חי').tv.menu, true);
  assert.equal(liveIntent('תשמיע לי שידור חי').tv.menu, true);
});
test('a live page by its address plays it', () => {
  assert.equal(liveIntent('תשמיע לי את השידור החי של kolchai.co.il').tv.url, 'https://kolchai.co.il');
});
test('a live broadcast by name is searched in extension 2', () => {
  assert.equal(liveIntent('תשמיע לי את השידור החי של הכותל ביוטיוב').webQuery, 'הכותל שידור חי');
});
test('not a live request: news about a channel, a question about the system, a video', () => {
  assert.equal(liveIntent('איזה סרטונים יצאו לאחרונה בערוץ 14'), null);
  assert.equal(liveIntent('מה אמרו בערוץ 14 על הבחירות'), null);
  assert.equal(liveIntent('אתה יכול להשמיע שידור חי?'), null);
  assert.equal(liveIntent('מה השיעור האחרון של גואל אלקריף'), null);
});
