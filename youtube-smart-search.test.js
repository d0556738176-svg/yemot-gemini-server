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

const planFetch = plan => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] }) });
const listSearch = (map, calls) => async q => { calls.push(q); const l = (map[q] || []).map((t, i) => ({ videoId: q.slice(0, 4) + i, title: t })); return l; };

test('Hebrew description of an English video: an English search runs too and its result is in the list', async () => {
  const calls = [];
  const map = { 'the clown killer case': ['The Clown Killer Case That Fooled Everyone'], 'תיק הליצן הרוצח': ['סתם כותרת'] };
  const r = await smartYouTubeSearch('תיק הליצן הרוצח שהטעה את כולם', { fetchImpl: planFetch({ he: 'תיק הליצן הרוצח', en: 'the clown killer case', topics: [] }) }, { GROQ_API_KEY: 'k' }, listSearch(map, calls), { webHints: async () => null });
  assert.ok(calls.includes('the clown killer case'));
  assert.ok(r.some(v => /Clown Killer/.test(v.title)));
  assert.equal(r.plan.english, false);
});

test('asked "באנגלית": the English search leads and counts in the ranking', async () => {
  const calls = [];
  const map = { 'clown killer case': ['The Clown Killer Case That Fooled Everyone'], 'תיק הליצן': ['תיק הליצן - כתבה', 'תיק הליצן - חלק ב'] };
  const r = await smartYouTubeSearch('תיק הליצן באנגלית', { fetchImpl: planFetch({ he: 'תיק הליצן', en: 'clown killer case', topics: [] }) }, { GROQ_API_KEY: 'k' }, listSearch(map, calls), { webHints: async () => null });
  assert.match(r[0].title, /Clown Killer/);
  assert.equal(r.plan.english, true);
});

test('request by topic or style: the focused topic searches run', async () => {
  const calls = [];
  const r = await smartYouTubeSearch('משהו שקט ורגוע לשבת בלי כלים', { fetchImpl: planFetch({ he: 'שירי שבת שקטים', en: 'calm shabbat songs', topics: ['ניגוני שבת ווקאלי', 'שירי שבת אקפלה רגועים'] }) }, { GROQ_API_KEY: 'k' }, listSearch({ 'ניגוני שבת ווקאלי': ['ניגון'] }, calls), { webHints: async () => null });
  assert.ok(calls.includes('ניגוני שבת ווקאלי') && calls.includes('שירי שבת אקפלה רגועים'));
  assert.ok(r.some(v => v.title === 'ניגון'));
});

import { wantsNewestQuery, channelNameFrom, orderChannelUploads } from './youtube-ivr.js';
test('newest requests are recognized, "חדש" alone included', () => {
  for (const q of ['סרטון חדש של הערוץ אבג', 'הסרטון הכי חדש של אבג', 'הפרק החדש של אבג המלא', 'השיעור האחרון של הרב'])
    assert.equal(wantsNewestQuery(q), true, q);
  assert.equal(wantsNewestQuery('חדשות הבוקר'), false);
  assert.equal(channelNameFrom('סרטון של הערוץ אבג דהו'), 'סרטון אבג דהו');
  assert.equal(channelNameFrom('הפרק המלא של אבג'), 'אבג');
});
test('a show on a broadcaster channel: its own newest episode first, full episode first when asked', () => {
  const v = (id, title, d) => ({ videoId: id, title, publishedAt: '2026-11-' + d + 'T10:00:00Z' });
  const out = orderChannelUploads([v('a', 'תוכנית אחרת', '12'), v('b', 'אבג - קטע', '11'), v('c', 'אבג פרק מלא', '10'), v('d', 'אבג פרק מלא', '03')], 'אבג', false, true);
  assert.deepEqual(out.map(x => x.videoId), ['c', 'd', 'b', 'a']);
});
test('newest request: the channel list keeps its date order (no English/topic searches, no reordering)', async () => {
  const calls = [];
  const search = async q => { calls.push(q); return q.includes('חדש') ? [{ videoId: 'n1', title: 'זה החדש' }, { videoId: 'n2', title: 'אבג דהו ישן יותר' }] : []; };
  const r = await smartYouTubeSearch('הסרטון הכי חדש של אבג דהו', { fetchImpl: planFetch({ he: 'אבג דהו חדש', en: 'abc new', topics: ['x', 'y'] }) }, { GROQ_API_KEY: 'k' }, search, { webHints: async () => null });
  assert.deepEqual(r.slice(0, 2).map(v => v.videoId), ['n1', 'n2']);
  assert.ok(!calls.includes('abc new') && !calls.includes('x'));
  assert.equal(r.plan.newest, true);
});

test('request by topic: the focused searches lead the list', async () => {
  const search = async q => (q === 'שירי אקפלה לשבת' ? [{ videoId: 'acap', title: 'אקפלה' }] : [{ videoId: 'pian' + q.length, title: 'פסנתר' }]);
  const r = await smartYouTubeSearch('משהו שקט לשבת בלי כלי נגינה', { fetchImpl: planFetch({ he: 'שירים שקטים', en: 'quiet', topics: ['שירי אקפלה לשבת', 'ווקאלי רגוע'] }) }, { GROQ_API_KEY: 'k' }, search, { webHints: async () => null });
  assert.equal(r[0].videoId, 'acap');
});
