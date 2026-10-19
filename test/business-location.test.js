import test from 'node:test';
import assert from 'node:assert/strict';
import { extractExplicitLocation, extractLocalArea, extractSearchCity } from '../business-location.js';
import { buildBusinessHoursQueries, buildBusinessHoursFallback } from '../business-hours.js';

test('extracts the city from a Super-Pharm Azrieli mall request', () => {
  const q = 'מה שעות הפתיחה של סניף סופר-פארם בקניון עזריאלי בתל אביב?';
  assert.equal(extractSearchCity(q), 'תל אביב');
  assert.match(extractLocalArea(q), /עזריאלי/);
  assert.deepEqual(extractExplicitLocation(q), { city: 'תל אביב', area: 'עזריאלי' });
});

test('recognizes a neighborhood and its city instead of a nearby neighborhood', () => {
  const q = 'אילו חנויות יש בשכונת רמות דוד בקריית גת?';
  assert.equal(extractSearchCity(q), 'קריית גת');
  assert.equal(extractLocalArea(q), 'רמות דוד');
  assert.deepEqual(extractExplicitLocation(q), { city: 'קריית גת', area: 'רמות דוד' });
});

test('handles alternate spelling of Kiryat Gat', () => {
  assert.equal(extractSearchCity('חנויות בקרית גת'), 'קרית גת');
});

test('business-hours queries include the exact mall, city and official brand domain', () => {
  const queries = buildBusinessHoursQueries({
    targets: ['סופר-פארם'],
    locationText: 'עזריאלי תל אביב',
    city: 'תל אביב',
    area: 'עזריאלי',
    question: 'מה שעות הפתיחה של סניף סופר-פארם בקניון עזריאלי בתל אביב?'
  });
  assert.ok(queries.some(q => q.includes('עזריאלי') && q.includes('תל אביב')));
  assert.ok(queries.some(q => q.includes('site:super-pharm.co.il')));
  assert.ok(queries.length <= 12);
});

test('no-result fallback does not falsely claim that the branch does not exist', () => {
  const answer = buildBusinessHoursFallback({
    question: 'מה שעות הפתיחה של סניף סופר-פארם בקניון עזריאלי בתל אביב?',
    business: 'סופר-פארם',
    city: 'תל אביב',
    area: 'עזריאלי',
    locationText: 'עזריאלי תל אביב',
    results: []
  });
  assert.match(answer, /לא הציגו שעות פתיחה|לא נמצאו שעות פתיחה|לא הצלחתי/i);
  assert.doesNotMatch(answer, /אין סניף|לא קיים סניף/);
});
