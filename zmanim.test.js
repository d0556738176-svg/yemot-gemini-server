import test from 'node:test';
import assert from 'node:assert/strict';
import { isZmanimQuestion, resolveZmanimLocation, resolveZmanimDate, answerZmanimQuestion } from './zmanim.js';

const TIMES = {
  alotHaShachar:'2026-10-30T05:05:00+02:00', misheyakir:'2026-10-30T05:30:00+02:00',
  sunrise:'2026-10-30T06:15:00+02:00', sofZmanShmaMGA:'2026-10-30T08:20:00+02:00',
  sofZmanShma:'2026-10-30T08:56:00+02:00', sofZmanTfillaMGA:'2026-10-30T09:25:00+02:00',
  sofZmanTfilla:'2026-10-30T09:58:00+02:00', chatzot:'2026-10-30T11:38:00+02:00',
  minchaGedola:'2026-10-30T12:08:00+02:00', plagHaMincha:'2026-10-30T15:48:00+02:00',
  sunset:'2026-10-30T17:02:00+02:00', tzeit7083deg:'2026-10-30T17:24:00+02:00', tzeit72min:'2026-10-30T18:14:00+02:00'
};
const mockFetch = async () => ({ ok:true, json: async () => ({ times: TIMES }) });

test('detects zmanim questions and ignores unrelated ones', () => {
  assert.ok(isZmanimQuestion('מתי סוף זמן קריאת שמע בבית שמש למחר'));
  assert.ok(isZmanimQuestion('באיזו שעה השקיעה היום'));
  assert.ok(!isZmanimQuestion('תן לי מתכון לעוגיות'));
  assert.ok(!isZmanimQuestion('מה שלומך'));
});

test('sof zman kriat shema returns the real MORNING time with GRA and MGA, not a hallucinated afternoon', async () => {
  const ans = await answerZmanimQuestion('מתי סוף זמן קריאת שמע בבית שמש למחר', { fetchImpl: mockFetch, now: new Date('2026-10-29T12:00:00+02:00') });
  assert.ok(ans.includes('08:56'), 'GRA morning time present');
  assert.ok(ans.includes('08:20'), 'MGA morning time present');
  assert.ok(ans.includes('המגן אברהם'));
  assert.ok(ans.includes('בית שמש'));
  assert.ok(!/1[7-9]:|2[0-3]:/.test(ans), 'no afternoon/evening time for a morning zman');
});

test('location and date resolution', () => {
  assert.equal(resolveZmanimLocation('סוף זמן קריאת שמע בירושלים').name, 'ירושלים');
  assert.equal(resolveZmanimLocation('מתי השקיעה').name, 'בית שמש'); // default
  assert.equal(resolveZmanimDate('מתי השקיעה למחר', new Date('2026-10-29T12:00:00+02:00')), '2026-10-30');
  assert.equal(resolveZmanimDate('מתי השקיעה היום', new Date('2026-10-29T12:00:00+02:00')), '2026-10-29');
});

test('candle lighting uses the city custom minutes before sunset', async () => {
  const ans = await answerZmanimQuestion('מתי הדלקת נרות בירושלים', { fetchImpl: async()=>({ok:true,json:async()=>({times:TIMES})}), now: new Date('2026-10-30T10:00:00+02:00') });
  assert.ok(ans.includes('הדלקת נרות'));
  assert.ok(ans.includes('ירושלים'));
  assert.ok(ans.includes('16:22'), 'Jerusalem 40 min before 17:02 sunset = 16:22');
});
