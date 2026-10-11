import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWebsiteResult } from '../website-selection.js';

test('selects a result that matches the requested website instead of the first result', () => {
  const unrelated = { title: 'YouTube', url: 'https://www.youtube.com/watch?v=123' };
  const requested = { title: 'פרוג - אתר החדשות', url: 'https://www.prog.co.il/' };
  assert.equal(selectWebsiteResult('תפתח לי את האתר של פרוג', [unrelated, requested]), requested);
});

test('does not open the first result when none matches the requested website', () => {
  const results = [
    { title: 'YouTube', url: 'https://www.youtube.com/' },
    { title: 'דף הבית', url: 'https://example.org/' }
  ];
  assert.equal(selectWebsiteResult('תפתח לי את האתר של פרוג', results), null);
});

test('returns null for missing or vague requested site names', () => {
  assert.equal(selectWebsiteResult('תפתח לי את האתר', [{ title: 'Homepage', url: 'https://example.org/' }]), null);
  assert.equal(selectWebsiteResult('תפתח לי את האתר של פרוג', []), null);
});

test('matches a domain token in the URL when the title is generic', () => {
  const requested = { title: 'דף הבית', url: 'https://prog.co.il/' };
  assert.equal(selectWebsiteResult('תפתח לי את האתר של prog', [requested]), requested);
});

test('allows an explicit request to open YouTube when the result matches', () => {
  const requested = { title: 'YouTube', url: 'https://www.youtube.com/' };
  assert.equal(selectWebsiteResult('תפתח לי את האתר של YouTube', [requested]), requested);
});

test('rejects non-web URL schemes even when their text matches the requested site', () => {
  const unsafe = { title: 'פרוג', url: 'javascript:alert(1)' };
  assert.equal(selectWebsiteResult('תפתח לי את האתר של פרוג', [unsafe]), null);
});
