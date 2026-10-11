import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublicWebsitePages } from '../website-reader.js';

test('returns an empty list for unsafe or unsupported URLs', async () => {
  assert.deepEqual(await readPublicWebsitePages({ startUrl: 'file:///etc/passwd' }), []);
  assert.deepEqual(await readPublicWebsitePages({ startUrl: 'http://127.0.0.1:3000/' }), []);
  assert.deepEqual(await readPublicWebsitePages({ startUrl: 'http://localhost/' }), []);
});

test('does not follow cross-origin search URLs', async () => {
  assert.deepEqual(await readPublicWebsitePages({
    startUrl: 'https://example.com/',
    rootUrl: 'https://example.com/',
    searchUrls: ['https://other.example/page']
  }), []);
});
