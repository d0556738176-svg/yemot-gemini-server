import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalBusinessResultsAnswer } from './local-business-search.js';

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
