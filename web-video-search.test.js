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

test('a Serper key with no credits is skipped and the backup engines answer at once', async () => {
  const { searchWebVideos } = await import('./web-video-search.js');
  let serperCalls = 0, lang = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('serper.dev')) { serperCalls++; return new Response('{"message":"Not enough credits"}', { status: 400 }); }
    if (String(url).includes('langsearch')) { lang++; return new Response(JSON.stringify({ data: { webPages: { value: [{ url: 'https://example.org/shiur/1', name: 'שיעור' }] } } }), { status: 200 }); }
    return new Response('{}', { status: 500 });
  };
  const env = { SERPER_API_KEY: 'k-test-spent', LANGSEARCH_API_KEY: 'l' };
  const a = await searchWebVideos('שיעור בדיקה', { env, fetchImpl });
  assert.ok(a.items.length >= 1);
  assert.ok(lang > 0);
  const first = serperCalls;
  const b = await searchWebVideos('שיעור בדיקה שני', { env, fetchImpl });
  assert.equal(serperCalls, first, 'the spent key is not called again');
  assert.ok(b.items.length >= 1);
});
