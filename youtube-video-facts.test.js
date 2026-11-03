import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchVideoFacts, publishedAgoHebrew, viewsHebrew } from './youtube-video-facts.js';

const now = Date.parse('2026-11-03T00:00:00Z');
const ago = ms => new Date(now - ms).toISOString();
const H = 3600000, D = 24 * H;

test('publish age is spoken naturally', () => {
  assert.equal(publishedAgoHebrew(ago(20 * 60000), now), 'לפני פחות משעה');
  assert.equal(publishedAgoHebrew(ago(2 * H), now), 'לפני שעתיים');
  assert.equal(publishedAgoHebrew(ago(5 * H), now), 'לפני 5 שעות');
  assert.equal(publishedAgoHebrew(ago(30 * H), now), 'אתמול');
  assert.equal(publishedAgoHebrew(ago(4 * D), now), 'לפני 4 ימים');
  assert.equal(publishedAgoHebrew(ago(15 * D), now), 'לפני שבועיים');
  assert.equal(publishedAgoHebrew(ago(65 * D), now), 'לפני חודשיים');
  assert.equal(publishedAgoHebrew(ago(400 * D), now), 'לפני שנה');
  assert.equal(publishedAgoHebrew(ago(3 * 366 * D), now), 'לפני 3 שנים');
  assert.equal(publishedAgoHebrew('garbage', now), '');
});

test('view counts are spoken the way people say them', () => {
  assert.equal(viewsHebrew(0), 'אין לו עדיין צפיות');
  assert.equal(viewsHebrew(1), 'יש לו צפייה אחת');
  assert.equal(viewsHebrew(842), 'יש לו 842 צפיות');
  assert.equal(viewsHebrew(1200), 'יש לו בערך אלף צפיות');
  assert.equal(viewsHebrew(12345), 'יש לו בערך 12 אלף צפיות');
  assert.equal(viewsHebrew(1340000), 'יש לו בערך מיליון ושלוש מאות אלף צפיות');
  assert.equal(viewsHebrew(2000000), 'יש לו בערך שני מיליון צפיות');
  assert.equal(viewsHebrew(45678901), 'יש לו בערך 45 מיליון צפיות');
  assert.equal(viewsHebrew(999700), 'יש לו בערך מיליון צפיות');
  assert.equal(viewsHebrew(null), '');
  assert.equal(viewsHebrew(3400000000), 'יש לו בערך 3 מיליארד צפיות');
  for (const n of [1200, 1340000, 999700, 5e9]) assert.doesNotMatch(viewsHebrew(n), /[-.]/);
});

test('one API call returns length, publish date and views', async () => {
  let calls = 0;
  const facts = await fetchVideoFacts('abcdefghijk', { YOUTUBE_API_KEY: 'k' }, async url => {
    calls++; assert.match(String(url), /part=contentDetails%2Csnippet%2Cstatistics/);
    return Response.json({ items: [{ contentDetails: { duration: 'PT4M13S' }, snippet: { publishedAt: '2020-01-01T00:00:00Z' }, statistics: { viewCount: '12345' } }] });
  });
  assert.deepEqual(facts, { durationSeconds: 253, publishedAt: '2020-01-01T00:00:00Z', viewCount: 12345 });
  assert.equal(calls, 1);
  const hidden = await fetchVideoFacts('abcdefghijk', { YOUTUBE_API_KEY: 'k' }, async () =>
    Response.json({ items: [{ contentDetails: { duration: 'PT1M' }, snippet: {}, statistics: {} }] }));
  assert.equal(hidden.viewCount, null);
});
