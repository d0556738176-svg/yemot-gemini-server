import test from 'node:test';
import assert from 'node:assert/strict';
import { smartYouTubeSearch, moreYouTubeResults } from './youtube-smart-search.js';

const fakeSearch = calls => async (q, o = {}) => {
  calls.push([q, o.pageToken || null]);
  const base = q === 'מרדכי בן דוד' ? 'a' : 'b';
  const page = o.pageToken ? 2 : 1;
  const list = [1, 2, 3].map(i => ({ videoId: base + page + i, title: q }));
  Object.defineProperty(list, 'nextPageToken', { value: page === 1 ? 'T' + base : null });
  return list;
};
test('smart query and the caller words are both searched and merged', async () => {
  const calls = [];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'מרדכי בן דוד' } }] }) });
  const r = await smartYouTubeSearch('תחפש לי מרדכי בן דויד', { fetchImpl }, { GROQ_API_KEY: 'k' }, fakeSearch(calls));
  assert.equal(r.rewritten, 'מרדכי בן דוד');
  assert.equal(calls.length, 2);
  assert.equal(r[0].videoId, 'a11'); assert.equal(r[1].videoId, 'b11');
  assert.equal(r.length, 6);
  const more = await moreYouTubeResults(r, {}, fakeSearch(calls));
  assert.equal(more.add.length, 6);
  assert.ok(more.add.every(v => /2/.test(v.videoId)));
});
test('without the model it is the plain search', async () => {
  const calls = [];
  const r = await smartYouTubeSearch('שיר', {}, {}, fakeSearch(calls));
  assert.equal(calls.length, 1); assert.equal(r.length, 3);
});
