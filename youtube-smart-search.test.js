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

test('misheard name: web search links come first and its titles reach the rewrite', async () => {
  const calls = [];
  let sentToModel = '';
  const fetchImpl = async (url, init) => {
    sentToModel = JSON.parse(init.body).messages[1].content;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'מוטי שטיינמץ הנשמה בקרבי' } }] }) };
  };
  const webHints = async () => ({ provider: 'serper', corrected: null, titles: ['מוטי שטיינמץ - הנשמה בקרבי'], videos: [{ videoId: 'WEBWEBWEB01', title: 'מוטי שטיינמץ - הנשמה בקרבי' }] });
  const videosByIds = async ids => ids.map(id => ({ videoId: id, title: 'מוטי שטיינמץ - הנשמה בקרבי' }));
  const r = await smartYouTubeSearch('מוטי שטיין מס הנשמה בקרבי', { fetchImpl, apiKey: 'k' }, { GROQ_API_KEY: 'k' }, fakeSearch(calls), { webHints, videosByIds });
  assert.equal(r[0].videoId, 'WEBWEBWEB01');
  assert.match(sentToModel, /מוטי שטיינמץ - הנשמה בקרבי/);
  assert.equal(r.rewritten, 'מוטי שטיינמץ הנשמה בקרבי');
  assert.equal(r.web.provider, 'serper');
});

test('no web provider and no model: the plain search still works', async () => {
  const calls = [];
  const r = await smartYouTubeSearch('שיר', {}, {}, fakeSearch(calls), { webHints: async () => null });
  assert.ok(r.length > 0);
});

import { videoIdFromUrl } from './youtube-web-hints.js';
test('video ids are read from every YouTube link form', () => {
  assert.equal(videoIdFromUrl('https://www.youtube.com/watch?v=abcdefghijk&t=3'), 'abcdefghijk');
  assert.equal(videoIdFromUrl('https://youtu.be/abcdefghijk'), 'abcdefghijk');
  assert.equal(videoIdFromUrl('https://www.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(videoIdFromUrl('https://www.youtube.com/@channel'), null);
});

import { webYouTubeHints } from './youtube-web-hints.js';
test('main server busy once (429): one retry, then the result is used and cached', async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1
    ? { ok: false, status: 429, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ provider: 'serper', videos: [{ videoId: 'abcdefghijk', title: 'T' }], titles: ['T'] }) });
  const env = { WEB_HINTS_SECRET: 's' };
  const h = await webYouTubeHints('retry test words', { env, fetchImpl });
  assert.equal(h.videos[0].videoId, 'abcdefghijk');
  assert.equal(h.provider, 'main:serper');
  await webYouTubeHints('retry test words', { env, fetchImpl });
  assert.equal(n, 2);
});

test('the rewrite never adds the word YouTube to the search', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'בדיחה YouTube' } }] }) });
  const { rewriteSearchQuery } = await import('./youtube-smart-search.js');
  assert.equal(await rewriteSearchQuery('בדיחה', { GROQ_API_KEY: 'k' }, fetchImpl), 'בדיחה');
});

import { soundScore, rankBySound } from './youtube-smart-search.js';
test('misheard name: the song whose title sounds like the request goes first', () => {
  const list = [
    { videoId: 'a', title: '9. חיים ישראל - כל הלילות' },
    { videoId: 'b', title: 'שמוליק לונגר & יואלי קליין - מאיר\'ל מיין קינד' },
    { videoId: 'c', title: 'מוטי שטיינמץ - הנשמה בקרבי | Motty Steinmetz-Haneshama Bekirbi' },
  ];
  rankBySound(list, ['מוטי שטיין מס הנשמה בקר בי']);
  assert.equal(list[0].videoId, 'c');
  assert.ok(soundScore('מוטי שטיין מס הנשמה בקר בי', list[0].title) > 0.6);
});
test('a vague request keeps YouTube order', () => {
  const list = [{ videoId: 'x', title: 'aaa' }, { videoId: 'y', title: 'bbb' }];
  rankBySound(list, ['בדיחה']);
  assert.deepEqual(list.map(v => v.videoId), ['x', 'y']);
});
