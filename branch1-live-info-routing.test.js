import test from 'node:test';
import assert from 'node:assert/strict';
import { isBusinessHoursQuestion, buildBusinessHoursQueries } from './business-hours.js';
import { isNewsQuestion, buildNewsSearchQueries } from './news-routing.js';

test('recognizes live opening-hours requests for a named business', () => {
  assert.equal(isBusinessHoursQuestion('מה שעות הפתיחה של סופר פארם בקניון עזריאלי בתל אביב?'), true);
  assert.equal(isBusinessHoursQuestion('האם דיסקונט פתוח עכשיו בתל אביב?'), true);
});

test('does not misclassify a generic phone-number request as opening hours', () => {
  assert.equal(isBusinessHoursQuestion('מה המספר של דיסקונט?'), false);
});

test('opening-hours queries preserve the requested branch and location', () => {
  const queries = buildBusinessHoursQueries({
    targets: ['סופר-פארם'],
    locationText: 'קניון עזריאלי תל אביב',
    city: 'תל אביב',
    area: 'קניון עזריאלי',
    question: 'מה שעות הפתיחה של סופר פארם בקניון עזריאלי בתל אביב?'
  });
  assert.ok(queries.length > 0);
  assert.ok(queries.some(q => q.includes('קניון עזריאלי') && q.includes('תל אביב')));
  assert.ok(queries.some(q => q.includes('super-pharm.co.il')));
});

test('recognizes current-news questions but not unrelated opening-hours questions', () => {
  assert.equal(isNewsQuestion('מה החדשות היום בישראל?'), true);
  assert.equal(isNewsQuestion('מה שעות הפתיחה של סופר פארם?'), false);
});

test('routes named Israeli news channels to their own official-source query', () => {
  const queries = buildNewsSearchQueries('חדשות ערוץ 14 היום');
  assert.ok(queries.some(q => q.includes('c14.co.il')));
});
