// Owner, 18.11: 20 results at once, several downloads, search history,
// "ערוץ 14 חדש" = the channel newest first, "בנושא", other languages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSelection, spokenNumbers, createBatchQueue } from './branch2-batch.js';
import { addToHistory, readHistory, historyPageText } from './branch2-search-history.js';
import { smartYouTubeSearch, moreYouTubeResults, requestedLanguage, wantsTopic, withoutSteering, titleInLanguage } from './youtube-smart-search.js';
import { channelNameFrom, wantsNewestQuery } from './youtube-ivr.js';

test('typed numbers in a row: the owner example and other cases', () => {
  assert.deepEqual(parseSelection('123420', 20), [1, 2, 3, 4, 20]);
  assert.deepEqual(parseSelection('1520', 20), [1, 5, 20]);
  assert.deepEqual(parseSelection('1112', 20), [11, 12]);
  assert.deepEqual(parseSelection('15*17', 20), [15, 17]);
  assert.deepEqual(parseSelection('15', 20), [1, 5]);
  assert.deepEqual(parseSelection('15*', 20), [15]);
  assert.deepEqual(parseSelection('201', 20), [1, 20]); // not rising: still read
  assert.deepEqual(parseSelection('9999', 20), [9]);
  assert.deepEqual(parseSelection('', 20), []);
  assert.deepEqual(parseSelection('2530', 40), [2, 5, 30]);
  assert.equal(spokenNumbers([1, 2, 3, 4, 20]), '1, 2, 3, 4 ו 20');
});

const memStore = () => { const m = new Map(); return { m, read: async k => m.get(k) ?? null, write: async (k, d) => { m.set(k, JSON.parse(JSON.stringify(d))); } }; };

test('history: newest first, a repeated search moves up, read 20 at a time', async () => {
  const store = memStore();
  for (let i = 1; i <= 25; i++) await addToHistory('0501234567', 'חיפוש ' + i, store, { now: Date.UTC(2026, 10, 18, 10, i) });
  await addToHistory('0501234567', 'חיפוש 3', store, { now: Date.UTC(2026, 10, 18, 11, 0) });
  const items = await readHistory('0501234567', store);
  assert.equal(items.length, 25);
  assert.equal(items[0].q, 'חיפוש 3');
  assert.equal(items[1].q, 'חיפוש 25');
  const page1 = historyPageText(items, 0, 20, { now: Date.UTC(2026, 10, 18, 11, 1) });
  assert.match(page1, /^1, חיפוש 3, עכשיו, 2, חיפוש 25/);
  assert.equal((page1.match(/\d+, חיפוש/g) || []).length, 20);
  assert.match(historyPageText(items, 20, 20), /^21, /);
  assert.deepEqual(await readHistory('', store), []);
  assert.equal(await addToHistory('12', 'x', store), null); // no caller number
});

test('batch queue: one download after another, no duplicates, survives a restart', async () => {
  const store = memStore();
  const started = [];
  const states = {};
  const q = createBatchQueue({ store, pollMs: 5, log: { info() {}, warn() {} }, start: async it => { started.push(it.videoId); states[it.videoId] = { status: 'running' }; return states[it.videoId]; } });
  const vids = ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3'].map(videoId => ({ videoId, title: 't' }));
  const r = await q.add([...vids, vids[0], { videoId: 'bad' }], { kind: 'audio' });
  assert.equal(r.added, 3);
  await new Promise(x => setTimeout(x, 20));
  assert.deepEqual(started, ['aaaaaaaaaa1']); // only one at a time
  states.aaaaaaaaaa1.status = 'ready';
  await new Promise(x => setTimeout(x, 30));
  assert.deepEqual(started, ['aaaaaaaaaa1', 'aaaaaaaaaa2']);
  // a restart now: the waiting one is in storage and continues
  const saved = store.m.get('ivr2:/2/youtubejobs/batch-queue.json');
  assert.deepEqual(saved.items.map(x => x.videoId), ['aaaaaaaaaa3']);
  const started2 = [];
  const q2 = createBatchQueue({ store, pollMs: 5, log: { info() {}, warn() {} }, start: async it => { started2.push(it.videoId); return { status: 'ready' }; } });
  assert.equal(await q2.resume(), 1);
  await new Promise(x => setTimeout(x, 20));
  assert.deepEqual(started2, ['aaaaaaaaaa3']);
  states.aaaaaaaaaa2.status = 'ready';
  await new Promise(x => setTimeout(x, 20));
  states.aaaaaaaaaa3 && (states.aaaaaaaaaa3.status = 'ready');
  await new Promise(x => setTimeout(x, 20));
});

test('steering words: language, topic, newest', () => {
  assert.equal(requestedLanguage('שיעור על אמונה באנגלית').code, 'en');
  assert.equal(requestedLanguage('שירים ביידיש').code, 'yi');
  assert.equal(requestedLanguage('מוזיקה בצרפתית').code, 'fr');
  assert.equal(requestedLanguage('סרטון בשפה הרוסית').code, 'ru');
  assert.equal(requestedLanguage('ישי ריבו'), null);
  assert.equal(requestedLanguage('ברוסלב'), null); // a word that starts like a language is not one
  assert.equal(requestedLanguage('some english words here').code, 'en');
  assert.ok(wantsTopic('ניסים בנושא'));
  assert.ok(!wantsTopic('ישי ריבו'));
  assert.equal(withoutSteering('שיעורים על אמונה באנגלית בנושא'), 'שיעורים על אמונה');
  assert.ok(wantsNewestQuery('ערוץ 14 חדש'));
  assert.equal(channelNameFrom('ערוץ 14'), 'ערוץ 14');
  assert.equal(channelNameFrom('הערוץ של אבג'), 'אבג');
  assert.ok(titleInLanguage('Faith and trust', requestedLanguage('באנגלית')));
  assert.ok(!titleInLanguage('אמונה Faith', requestedLanguage('באנגלית')));
  assert.ok(titleInLanguage('Вера', requestedLanguage('ברוסית')));
});

const model = content => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

test('"ערוץ 14 חדש": the channel the model names, its uploads newest first, and 20 more after', async () => {
  const calls = [];
  const search = async (q, o = {}) => {
    calls.push([q, !!o.newest]);
    if (q === 'עכשיו 14 חדש') {
      const l = Array.from({ length: 50 }, (_, i) => ({ videoId: 'c' + String(i).padStart(10, '0'), title: 'כתבה ' + i, publishedAt: new Date(Date.UTC(2026, 10, 18) - i * 3600e3).toISOString() }));
      Object.defineProperty(l, 'uploads', { value: { playlistId: 'UUnow14', token: 'P2', channelTitle: 'עכשיו 14' } });
      return l;
    }
    return [{ videoId: 'xxxxxxxxxx1', title: 'משהו אחר', publishedAt: '2020-01-01T00:00:00Z' }];
  };
  const r = await smartYouTubeSearch('ערוץ 14 חדש', { fetchImpl: model('{"he":"ערוץ 14 חדש","en":"channel 14","topics":[],"channel":"עכשיו 14"}') }, { GROQ_API_KEY: 'k' }, search, { webHints: async () => null });
  assert.equal(r.length, 50);
  assert.equal(r[0].title, 'כתבה 0');
  assert.ok(r.every(v => v.videoId.startsWith('c')));
  assert.equal(r.channel, 'עכשיו 14');
  assert.ok(calls.every(([, n]) => n));
  const more = await moreYouTubeResults(r, {}, async () => [], async (pl, tok) => { assert.equal(pl, 'UUnow14'); assert.equal(tok, 'P2'); const l = [{ videoId: 'd0000000001', title: 'ישן', publishedAt: '2026-01-01T00:00:00Z' }]; Object.defineProperty(l, 'nextPageToken', { value: 'P3' }); return l; });
  assert.equal(more.add[0].videoId, 'd0000000001');
  assert.equal(more.pages[0].token, 'P3');
});

test('newest with no channel found: date-sorted, newest first', async () => {
  const search = async q => [{ videoId: 'o' + q.length.toString().padStart(10, '0'), title: q, publishedAt: q.includes('אבג') ? '2026-11-01T00:00:00Z' : '2026-11-10T00:00:00Z' }];
  const r = await smartYouTubeSearch('אבג חדש', { fetchImpl: model('{"he":"אבגד","en":"x","topics":[],"channel":"אבגד"}') }, { GROQ_API_KEY: 'k' }, search, { webHints: async () => null });
  assert.ok(r.length >= 2);
  assert.ok(Date.parse(r[0].publishedAt) >= Date.parse(r[1].publishedAt));
});

test('"באנגלית": the English search is asked of YouTube in English and English titles come first', async () => {
  const calls = [];
  const search = async (q, o = {}) => { calls.push([q, o.relevanceLanguage || null]); return q === 'faith lectures' ? [{ videoId: 'e0000000001', title: 'Faith lecture' }] : [{ videoId: 'h0000000001', title: 'שיעור אמונה' }, { videoId: 'e0000000002', title: 'Emunah class' }]; };
  const r = await smartYouTubeSearch('שיעורים על אמונה באנגלית', { fetchImpl: model('{"he":"שיעורים על אמונה","en":"faith lectures","topics":[]}') }, { GROQ_API_KEY: 'k' }, search, { webHints: async () => null });
  assert.ok(calls.some(([q, l]) => q === 'faith lectures' && l === 'en'));
  assert.ok(calls.every(([q]) => !/באנגלית/.test(q)));
  assert.equal(r[0].videoId, 'e0000000001');
  assert.ok(r.findIndex(v => v.videoId === 'h0000000001') > r.findIndex(v => v.videoId === 'e0000000002'));
  assert.equal(r.lang, 'en');
});

test('"ביידיש": the model is asked for the search in Yiddish, YouTube for Yiddish', async () => {
  let sent = '';
  const calls = [];
  const fetchImpl = async (url, init) => { sent = JSON.parse(init.body).messages[0].content; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"he":"שירי חתונה","en":"חתונה לידער","topics":[]}' } }] }) }; };
  await smartYouTubeSearch('שירי חתונה ביידיש', { fetchImpl }, { GROQ_API_KEY: 'k' }, async (q, o = {}) => { calls.push([q, o.relevanceLanguage || null]); return []; }, { webHints: async () => null }).catch(() => {});
  assert.match(sent, /יידיש/);
  assert.ok(calls.some(([q, l]) => q === 'חתונה לידער' && l === 'yi'));
});

test('"בנושא": topic searches lead and are three; the word itself is not searched', async () => {
  let sent = '';
  const calls = [];
  const fetchImpl = async (url, init) => { sent = JSON.parse(init.body).messages[0].content; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"he":"ניסים","en":"miracles","topics":["סיפורי ניסים","ניסים גלויים","השגחה פרטית"]}' } }] }) }; };
  const r = await smartYouTubeSearch('ניסים בנושא', { fetchImpl }, { GROQ_API_KEY: 'k' }, async q => { calls.push(q); return [{ videoId: ('t' + q.length + 'xxxxxxxxxxx').slice(0, 11), title: q }]; }, { webHints: async () => null });
  assert.match(sent, /במפורש חיפוש לפי נושא/);
  assert.ok(calls.every(q => !/בנושא/.test(q)));
  assert.equal(r.plan.topics.length, 3);
  assert.equal(r[0].title, 'סיפורי ניסים');
});
