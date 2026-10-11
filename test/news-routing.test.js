import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewsQuestion, buildNewsSearchQueries } from '../news-routing.js';

test('recognizes news requests across security, politics, technology, health, and football', () => {
  for (const q of [
    'מה החדשות הביטחוניות היום',
    'מה חדש בפוליטיקה',
    'עדכונים אחרונים בטכנולוגיה',
    'מה קורה בתחום הבריאות היום',
    'מה החדשות בכדורגל עכשיו'
  ]) assert.equal(isNewsQuestion(q), true, q);
});

test('does not route ordinary non-news questions into the news pipeline', () => {
  assert.equal(isNewsQuestion('מה זה לחץ דם'), false);
  assert.equal(isNewsQuestion('מה קורה עם הטלפון שלי'), false);
});

test('general news briefing searches several topic lanes in parallel', () => {
  const queries = buildNewsSearchQueries('סקור לי חדשות בכל התחומים');
  assert.equal(queries.length, 3);
  assert.ok(queries.some(q => /ביטחון|פוליטיקה/.test(q)));
  assert.ok(queries.some(q => /טכנולוגיה|בריאות/.test(q)));
  assert.ok(queries.some(q => /כדורגל|ספורט/.test(q)));
});

test('specific topic stays focused on that topic', () => {
  const queries = buildNewsSearchQueries('מה החדשות בכדורגל היום');
  assert.equal(queries.length, 1);
  assert.match(queries[0], /כדורגל/);
});

test('source-specific news remains scoped to the requested channel', () => {
  assert.deepEqual(buildNewsSearchQueries('מה החדשות בערוץ 14'), ['site:c14.co.il חדשות היום']);
});

test('uses the previous headline for a clear follow-up request', () => {
  const queries = buildNewsSearchQueries('תרחיב על הכותרת הראשונה', 'כותרת 1: דיווח על עדכון טכנולוגי. כותרת 2: דיווח ספורט');
  assert.deepEqual(queries, ['דיווח על עדכון טכנולוגי']);
});
