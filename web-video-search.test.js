import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWebVideos } from './web-video-search.js';

test('all search response slots are merged, including actual Tavily results', async () => {
  let count = 0;
  const r = await searchWebVideos('episode', { env: { SERPER_API_KEY: 'test', TAVILY_API_KEY: 'test' },
    fetchImpl: async (url) => {
      const n = ++count;
      return { ok: true, json: async () => url.includes('tavily') ? { results: [{ url: 'https://tv.example/vod/tavily', title: 'Tavily' }] } : { organic: [{ link: 'https://tv.example/vod/' + n, title: 'Episode ' + n }], videos: [] } };
    } });
  assert.equal(count, 8);
  assert.equal(r.items.length, 6); // five organic requests + Tavily
  assert.ok(r.items.some(x => x.from === 'tavily'));
  assert.equal(r.engines.tavily, true);
});

test('distinct video query IDs survive while tracking duplicates collapse', async () => {
  const r = await searchWebVideos('episode', { env: { SERPER_API_KEY: 'test' }, fetchImpl: async () => ({ ok: true, json: async () => ({ videos: [
    { link: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'A' },
    { link: 'https://www.youtube.com/watch?v=lmnopqrstuv', title: 'B' },
    { link: 'https://www.youtube.com/watch?utm_source=test&v=abcdefghijk', title: 'Duplicate' },
    { link: 'https://[broken', title: 'Malformed' }
  ] }) }) });
  assert.equal(r.items.length, 2);
});

test('engine failures and missing keys remain safe empty results', async () => {
  const r = await searchWebVideos('episode', { env: {}, fetchImpl: async () => { throw Error('should not call'); } });
  assert.deepEqual(r.items, []);
});
