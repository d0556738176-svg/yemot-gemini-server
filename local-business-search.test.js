import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalBusinessResultsAnswer, isLocalBusinessDiscoveryRequest, buildLocalBusinessQueries, filterNearbyLocalBusinessResults } from './local-business-search.js';

test('names exact-neighborhood source results first', () => {
  const answer = buildLocalBusinessResultsAnswer({
    city: 'קריית גת', area: 'רמות דוד',
    exactResults: [{ title: 'מכולת רמות', url: 'https://example.com', snippet: 'מכולת שכונתית ברמות דוד' }],
    cityResults: [{ title: 'עסק עירוני', url: 'https://example.org', snippet: 'עסק בקריית גת' }]
  });
  assert.match(answer, /מכולת רמות/);
  assert.match(answer, /רמות דוד/);
  assert.doesNotMatch(answer, /עסק עירוני/);
});

test('labels city-level leads as not verified inside the neighborhood', () => {
  const answer = buildLocalBusinessResultsAnswer({
    city: 'קריית גת', area: 'רמות דוד', exactResults: [],
    cityResults: [{ title: 'חנות בקריית גת', url: 'https://example.com', snippet: 'חנות בעיר' }]
  });
  assert.match(answer, /חנות בקריית גת/);
  assert.match(answer, /לא אומת שהן בתוך השכונה/);
  assert.match(answer, /דווקא בתוך רמות דוד/);
});

test('does not invent business names when no results exist', () => {
  const answer = buildLocalBusinessResultsAnswer({ city: 'קריית גת', area: 'רמות דוד' });
  assert.match(answer, /לא הצלחתי לאמת/);
  assert.doesNotMatch(answer, /חנות אקראית/);
});

test('recognizes Kiryat Gat speech spelling and local parking/shop queries', () => {
  const location = { city: 'קריית גת', area: 'רמות דוד' };
  assert.equal(isLocalBusinessDiscoveryRequest('תמצא לי חניות ברמות דוד בקירית גת', location), true);
  const queries = buildLocalBusinessQueries('תמצא לי חניות ברמות דוד בקירית גת', location);
  assert.ok(queries.some(q => /חניונים|חניות/.test(q)));
  assert.ok(queries.some(q => /חנויות/.test(q)));
});

test('matches city-level results with common Kiryat Gat transcription variants', () => {
  const results = [{ title: 'חנות בקריית גת', url: 'https://example.com', snippet: 'עסק מקומי' }];
  assert.equal(filterNearbyLocalBusinessResults(results, { city: 'קריית גת', area: 'רמות דוד' }).length, 1);
});
