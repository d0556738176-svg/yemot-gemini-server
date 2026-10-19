import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLocalBusinessDiscoveryRequest,
  buildLocalBusinessQueries,
  filterLocalBusinessResults,
  filterNearbyLocalBusinessResults,
  buildNoVerifiedLocalResultsAnswer
} from '../local-business-search.js';

test('routes neighborhood shop discovery to the strict local search', () => {
  assert.equal(isLocalBusinessDiscoveryRequest('אילו חנויות יש בשכונת רמות דוד בקריית גת?', {
    city: 'קריית גת', area: 'רמות דוד'
  }), true);
});

test('does not intercept opening-hours or phone requests', () => {
  const location = { city: 'תל אביב', area: 'קניון עזריאלי' };
  assert.equal(isLocalBusinessDiscoveryRequest('מה שעות הפתיחה של סופר-פארם בקניון עזריאלי בתל אביב?', location), false);
  assert.equal(isLocalBusinessDiscoveryRequest('מה הטלפון של החנות בקניון עזריאלי בתל אביב?', location), false);
});

test('creates exact-area and city-wide search variants', () => {
  const queries = buildLocalBusinessQueries('אילו חנויות יש בשכונת רמות דוד בקריית גת?', {
    city: 'קריית גת', area: 'רמות דוד'
  });
  assert.ok(queries.some(q => q.includes('רמות דוד') && q.includes('קריית גת')));
  assert.ok(queries.some(q => q.includes('site:easy.co.il')));
  assert.ok(queries.some(q => q.includes('קריית גת') && q.includes('כתובות טלפון')));
});

test('excludes nearby Karmi Gat results from the exact neighborhood set', () => {
  const results = [
    { title: 'חנות שכונת רמות דוד, קריית גת', url: 'https://example.com/ramot-david', snippet: 'עסק בשכונת רמות דוד בקריית גת' },
    { title: 'חנויות כרמי גת, קריית גת', url: 'https://example.com/karmi-gat', snippet: 'מרכז מסחרי בכרמי גת' },
    { title: 'חנויות ברמות דוד', url: 'https://example.com/other-city', snippet: 'רמות דוד, עיר אחרת' }
  ];
  const filtered = filterLocalBusinessResults(results, { city: 'קריית גת', area: 'רמות דוד' });
  assert.deepEqual(filtered.map(x => x.url), ['https://example.com/ramot-david']);
});

test('returns city-level leads separately so they are not misrepresented as inside the neighborhood', () => {
  const results = [
    { title: 'חנויות כרמי גת, קריית גת', url: 'https://example.com/karmi-gat', snippet: 'מרכז מסחרי בכרמי גת' },
    { title: 'סופרמרקט במרכז קריית גת', url: 'https://example.com/market', snippet: 'כתובת בקריית גת' },
    { title: 'חנות רמות דוד, עיר אחרת', url: 'https://example.com/other', snippet: 'רמות דוד' }
  ];
  const nearby = filterNearbyLocalBusinessResults(results, { city: 'קריית גת', area: 'רמות דוד' });
  assert.deepEqual(nearby.map(x => x.url), ['https://example.com/karmi-gat', 'https://example.com/market']);
});

test('does not overclaim when no local sources verify a store', () => {
  const answer = buildNoVerifiedLocalResultsAnswer({ city: 'קריית גת', area: 'רמות דוד' });
  assert.match(answer, /דווקא ב/);
  assert.match(answer, /שכונה אחרת/);
});
