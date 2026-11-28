import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NEWS_STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'news-'));
const N = await import('../news-ext11.js');
const K = await import('../branch2-media-keys.js');

const feed = (title, items) => `<?xml version="1.0"?><feed><title>${title}</title>` + items.map(i => `<entry><yt:videoId>${i.id}</yt:videoId><title>${i.t}</title><link rel="alternate" href="https://www.youtube.com/${i.s ? 'shorts/' : 'watch?v='}${i.id}"/><published>${i.p}</published></entry>`).join('') + '</feed>';

function fakeYemot() {
  const files = new Map(), json = new Map(), ini = new Map();
  return { files, json, ini, publicUrl: 'https://ext2.example',
    readJson: async x => (json.has(x) ? structuredClone(json.get(x)) : null),
    writeJson: async (x, d) => { json.set(x, structuredClone(d)); },
    upload: async (f, r) => { files.set(r, f); },
    del: async w => { files.delete(w); },
    move: async (a, b) => { if (!files.has(a)) throw new Error('missing'); files.set(b, files.get(a)); files.delete(a); },
    saveSettings: async (d, t) => { ini.set(d, t); },
    retryWaits: [0] };
}

test('feed: titles, ids, shorts and entities', () => {
  const f = N.parseFeed(feed('חדשות 13', [{ id: 'NEJCc5QtZEc', t: 'א &amp; ב &quot;ג&quot;', p: '2026-11-25T15:52:52+00:00', s: true }]));
  assert.equal(f.channelTitle, 'חדשות 13');
  assert.deepEqual(f.items[0], { videoId: 'NEJCc5QtZEc', title: 'א & ב "ג"', published: '2026-11-25T15:52:52+00:00', short: true });
});

test('first round takes only the last 2 hours; later rounds take every new video', async () => {
  N._resetForTests();
  const now = Date.parse('2026-11-25T16:00:00Z');
  let items = [{ id: 'aaaaaaaaaa1', t: 'new', p: '2026-11-25T15:30:00Z' }, { id: 'aaaaaaaaaa2', t: 'old', p: '2026-11-25T10:00:00Z' }];
  const fetch = async u => String(u).includes('/@') ? { ok: true, text: async () => '<link rel="canonical" href="https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx">' } : { ok: true, text: async () => feed('x', items) };
  await N.pollOnce({ fetch }, now);
  let st = N.loadState();
  assert.ok(st.queue.aaaaaaaaaa1); assert.ok(!st.queue.aaaaaaaaaa2);
  items = [{ id: 'aaaaaaaaaa3', t: 'newer', p: '2026-11-25T16:01:00Z' }, ...items];
  await N.pollOnce({ fetch }, now + 120000);
  st = N.loadState();
  assert.ok(st.queue.aaaaaaaaaa3);
  assert.equal(st.queue.aaaaaaaaaa1.tries, 0);
});

test('worker: live waits; a finished one is downloaded, mastered, uploaded, and the server copy removed', async () => {
  N._resetForTests();
  const io = fakeYemot();
  const seenTmp = [];
  const probe = async v => v === 'aaaaaaaaaa3' ? { live: 'is_live' } : { live: 'not_live', durationSec: 90 };
  const deps = { log: { info() {}, warn() {} }, probe,
    download: async (v, out) => { writeFileSync(out, 'src'); seenTmp.push(path.dirname(out)); },
    master: async (src, out) => { writeFileSync(out, 'wav'); return { durationSec: 90 }; },
    publish: (v, w, m) => N.publishNews(v, w, m, io) };
  await (await N.workOnce(deps)).done;
  await (await N.workOnce(deps)).done;
  const st = N.loadState();
  assert.ok(st.queue.aaaaaaaaaa3, 'live stays queued'); assert.equal(st.queue.aaaaaaaaaa3.wait, 'is_live');
  assert.ok(!st.queue.aaaaaaaaaa1); assert.equal(st.seen.aaaaaaaaaa1, 'done');
  assert.ok(io.files.has('ivr2:/11/1/1/000.wav'));
  const { existsSync } = await import('node:fs');
  assert.ok(seenTmp.every(d => !existsSync(d)), 'temporary folder deleted');
  assert.match(io.ini.get('/11/1/1'), /control_play2=send_api/);
  assert.match(io.ini.get('/11/1/1'), /start=max/);
});

test('full folder (not news): the older half goes to the archive, the newer half moves down', async () => {
  N._resetForTests();
  const io = fakeYemot();
  const items = {};
  for (let n = 0; n < 1000; n++) { io.files.set('ivr2:/11/2/1/' + N.file3(n) + '.wav', 'f' + n); items['v' + String(n).padStart(10, '0')] = { dir: '/11/2/1', file: N.file3(n), title: 't' + n }; }
  const IX = 'ivr2:/2/youtubeaudio/news11_t2_index.json';
  await io.writeJson(IX, { version: 1, next: 1000, items, archives: 0 });
  const e = await N.publishNews('newvideo123', '/tmp/x.wav', { title: 'newest', topic: '2' }, io);
  assert.equal(e.file, '500');
  assert.equal(io.files.get('ivr2:/11/2/1/1/000.wav'), 'f0');
  assert.equal(io.files.get('ivr2:/11/2/1/1/499.wav'), 'f499');
  assert.equal(io.files.get('ivr2:/11/2/1/000.wav'), 'f500');
  const idx = await io.readJson(IX);
  assert.equal(idx.archives, 1); assert.equal(idx.next, 501);
  assert.match(io.ini.get('/11/2/1/1'), /type=playfile/);
});

test('full news folder: the oldest half is deleted, nothing archived', async () => {
  N._resetForTests();
  const io = fakeYemot();
  const items = {};
  for (let n = 0; n < 1000; n++) { io.files.set('ivr2:/11/1/1/' + N.file3(n) + '.wav', 'f' + n); items['v' + String(n).padStart(10, '0')] = { dir: '/11/1/1', file: N.file3(n), title: 't' + n }; }
  await io.writeJson(N.INDEX, { version: 1, next: 1000, items, archives: 0, layout: 'main-part' });
  const e = await N.publishNews('newvideo123', '/tmp/x.wav', { title: 'newest', topic: '1' }, io);
  assert.equal(e.file, '500');
  assert.equal(io.files.get('ivr2:/11/1/1/000.wav'), 'f500');
  assert.ok(!io.files.has('ivr2:/11/1/1/1/000.wav'));
  const idx = await io.readJson(N.INDEX);
  assert.equal(idx.archives, 0); assert.ok(!idx.items.v0000000000); assert.equal(idx.items.v0000000500.file, '000');
});

test('the files that were in 11/1 move once to 11/1/1', async () => {
  N._resetForTests();
  const io = fakeYemot();
  io.files.set('ivr2:/11/1/000.wav', 'a'); io.files.set('ivr2:/11/1/001.wav', 'b');
  await io.writeJson(N.INDEX, { next: 2, items: { x0000000000: { dir: '/11/1', file: '000' }, x0000000001: { dir: '/11/1', file: '001' } } });
  assert.equal(await N.moveNewsToMainPart(io), 2);
  assert.equal(io.files.get('ivr2:/11/1/1/001.wav'), 'b');
  assert.equal(await N.moveNewsToMainPart(io), 0);
  assert.equal((await N.lookupNews('/11/1/1', '000', io)).videoId, 'x0000000000');
});

test('key 2: asks 1/2; 1 deletes and plays the next older file; 2 cancels', async () => {
  N._resetForTests();
  const io = fakeYemot();
  for (const n of [0, 1, 2]) io.files.set('ivr2:/11/1/1/00' + n + '.wav', 'x');
  await io.writeJson(N.INDEX, { next: 3, items: { a0000000000: { dir: '/11/1/1', file: '000' }, a0000000001: { dir: '/11/1/1', file: '001' }, a0000000002: { dir: '/11/1/1', file: '002' } } });
  const deps = { lookup: (d, f) => N.lookupNews(d, f, io), canDelete: d => !!N.topicOfDir(d), deleteFile: (d, f) => N.deleteNews(d, f, io) };
  const ask = await K.handleMediaKey({ what: 'ivr2:/11/1/1/001.wav', PlayStop: '5000', PressKey: '2' }, deps, { info() {}, warn() {} });
  assert.match(ask, /^read=.*=del_ok,/);
  const no = await K.handleMediaKey({ what: 'ivr2:/11/1/1/001.wav', PlayStop: '5000', del_ok: '2' }, deps, { info() {}, warn() {} });
  assert.match(no, /go_to_folder_and_play=\/11\/1\/1,001,5000/); assert.ok(io.files.has('ivr2:/11/1/1/001.wav'));
  const yes = await K.handleMediaKey({ what: 'ivr2:/11/1/1/001.wav', PlayStop: '5000', del_ok: '1' }, deps, { info() {}, warn() {} });
  assert.ok(!io.files.has('ivr2:/11/1/1/001.wav'));
  assert.match(yes, /go_to_folder_and_play=\/11\/1\/1,000,0/);
  // Extension 7 never deletes with 2.
  const seven = await K.handleMediaKey({ what: 'ivr2:/7/005.wav', PlayStop: '0', PressKey: '2' }, { ...deps, lookup: async () => null }, {});
  assert.match(seven, /^go_to_folder_and_play=\/7,005,0$/);
});

test('probe output', () => {
  assert.deepEqual(N.parseProbe('is_live|NA\n'), { live: 'is_live', durationSec: null });
  assert.deepEqual(N.parseProbe('not_live|3600\n'), { live: 'not_live', durationSec: 3600 });
});

test('a broadcast that has not started is waited for, not given up', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yt-'));
  const bin = path.join(dir, 'yt-dlp');
  writeFileSync(bin, '#!/bin/sh\necho "ERROR: [youtube] x: This live event will begin in a few moments." >&2\nexit 1\n', { mode: 0o755 });
  assert.equal((await N.probeVideo('mLJTlNR1BIQ', bin)).live, 'is_upcoming');
});

test('key 8 details: the channel comes from the next source when one fails', async () => {
  const M = await import('../video-meta.js');
  M._clearMetaCache();
  // API: no keys answer; oEmbed answers with the channel.
  const fetchImpl = async u => String(u).includes('oembed') ? { ok: true, json: async () => ({ author_name: 'C14', title: 'כותרת' }) } : { ok: false, json: async () => ({}) };
  const f = await M.videoMeta('abcdefghijk', { env: { YOUTUBE_API_KEY: 'k1', YOUTUBE_API_KEY_2: 'k2' }, fetchImpl, ytdlp: async () => ({ channel: 'C14', durationSeconds: 125, publishedAt: '2026-11-25T12:00:00Z', viewCount: 9, dateOnly: true }), log: {} });
  assert.equal(f.channel, 'C14'); assert.equal(f.durationSeconds, 125); assert.deepEqual(f.sources, ['oembed', 'yt-dlp']);
  // Every online source down: the channel saved with the file.
  M._clearMetaCache();
  const g = await M.videoMeta('abcdefghij2', { env: {}, fetchImpl: async () => { throw new Error('down'); }, ytdlp: async () => null, hintChannel: 'ערוץ כנסת 99', log: {} });
  assert.equal(g.channel, 'ערוץ כנסת 99');
  assert.deepEqual(M.parseYtdlp('C14\u0001125\u000120261125\u0001340\u0001שם'), { channel: 'C14', durationSeconds: 125, viewCount: 340, publishedAt: '2026-11-25T12:00:00Z', title: 'שם', dateOnly: true });
});

test('topics: each topic files into its own extension and its own index', async () => {
  N._resetForTests();
  const io = fakeYemot();
  await N.publishNews('torahvideo1', '/tmp/x.wav', { topic: '2', title: 'שיעור' }, io);
  await N.publishNews('musicvideo1', '/tmp/x.wav', { topic: '3', title: 'שיר' }, io);
  await N.publishNews('yedid1413', '/tmp/x.wav', { topic: '2', title: 'קטע', url: 'https://hel1.your-objectstorage.com/x/y/z' }, io);
  assert.ok(io.files.has('ivr2:/11/2/1/000.wav')); assert.ok(io.files.has('ivr2:/11/2/1/001.wav')); assert.ok(io.files.has('ivr2:/11/3/000.wav'));
  assert.ok(!io.files.has('ivr2:/11/1/000.wav'));
  assert.equal((await N.lookupNews('/11/2/1', '000', io)).videoId, 'torahvideo1');
  const site = await N.lookupNews('/11/2/1', '001', io);
  assert.equal(site.videoId, null); assert.match(site.url, /objectstorage/);
  assert.deepEqual(N.topicOfDir('/11/3/2'), { t: '3', a: 2 }); assert.equal(N.topicOfDir('/11/97'), null);
  assert.match(io.ini.get('/11/3'), /title=מוזיקה/);
});

test('channel site: post list and a post page with its video file', () => {
  assert.deepEqual(N.parseSitemapPosts('<url><loc>https://x/</loc></url><url><loc>https://x/post/1412</loc></url><url><loc>https://x/post/1414</loc></url>'), [1414, 1412]);
  const p = N.parsePostPage('<meta property="og:title" content="##### **לא לחשוב היום על מחר🤚** 💥קטע חזק מהרב רפאל רובין [video-embedd… | ידיד נפש⚡"><time datetime="2026-11-25T19:45:10Z">x</time><p>[video-embedded#](https://hel1.your-objectstorage.com/chatfree-yedid-nefsh/95/dc/95dcbadd25)</p>');
  assert.equal(p.video, 'https://hel1.your-objectstorage.com/chatfree-yedid-nefsh/95/dc/95dcbadd25');
  assert.equal(p.title, 'לא לחשוב היום על מחר🤚 💥קטע חזק מהרב רפאל רובין');
  assert.equal(p.published, '2026-11-25T19:45:10Z');
});

test('a new topic starts with the newest few of each channel; news keeps first place in the work', async () => {
  N._resetForTests();
  const now = Date.parse('2026-11-25T16:00:00Z');
  const items = [1, 2, 3, 4, 5].map(i => ({ id: 'torahvid00' + i, t: 'ש' + i, p: new Date(now - i * 3600e3).toISOString() }));
  const fetch = async u => /results\?search_query/.test(String(u)) ? { ok: true, text: async () => '"channelRenderer":{"channelId":"UCyyyyyyyyyyyyyyyyyyyyyy"' } : /sitemap/.test(String(u)) ? { ok: true, text: async () => '' } : { ok: true, text: async () => feed('ch', items) };
  const st0 = N.loadState(); delete st0.topicStarted?.['2']; delete st0.topicPolled?.['2']; N.saveState(st0);
  await N.pollOnce({ fetch, topics: ['2'] }, now);
  const st = N.loadState();
  const queued = Object.values(st.queue).filter(q => q.topic === '2');
  assert.ok(queued.length >= 1 && queued.every(q => ['ש1', 'ש2', 'ש3'].includes(q.title)));
  assert.equal(N.serverBusy(5, 2000), true); assert.equal(N.serverBusy(1, 2000), false); assert.equal(N.serverBusy(1, 100), true);
});

test('English parts of a name are said in Hebrew letters (Yemot skips English)', async () => {
  const S = await import('../speak-latin.js');
  assert.equal(await S.speakable('C14'), 'סי 14');
  assert.equal(await S.speakable('i24NEWS עברית'), 'איי 24 ניוז עברית');
  assert.equal(await S.speakable('כאן | חדשות - תאגיד השידור הישראלי'), 'כאן | חדשות - תאגיד השידור הישראלי');
  assert.equal(await S.speakable('CNN בעברית'), 'סי אן אן בעברית');
  assert.equal(await S.speakable('Hidabroot TV'), 'הידברות טי וי');
  // Unknown word: transliteration; when that fails, letter by letter (never dropped).
  assert.equal(await S.speakable('Shalom Studio', { translit: async w => ({ Shalom: 'שלום' }) }), 'שלום סטודיו');
  assert.equal(await S.speakable('Zubi', { translit: async () => null }), 'זי יו בי איי');
});

test('channel search never takes an automatic Topic channel and prefers the singer by name', async () => {
  const N = await import('../news-ext11.js');
  const h = '"channelRenderer":{"channelId":"UC5rKMtdamiGoJUq4fsKn-pg","title":{"simpleText":"Zusha - Topic"}} "channelRenderer":{"channelId":"UCbbbbbbbbbbbbbbbbbbbbbb","title":{"simpleText":"Other"}} "channelRenderer":{"channelId":"UCaaaaaaaaaaaaaaaaaaaaaa","title":{"simpleText":"Akiva Turgeman"}}';
  assert.equal(N.pickChannel(h, ['Turgeman']), 'UCaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(N.pickChannel(h, []), 'UCbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(N.pickChannel('"channelRenderer":{"channelId":"UCcccccccccccccccccccccc"', []), 'UCcccccccccccccccccccccc');
});

test('a topic whose first round is made again looks once more at songs it skipped as old', async () => {
  N._resetForTests();
  const now = Date.parse('2026-11-26T10:00:00Z');
  const st0 = N.loadState();
  st0.topicStarted = { '3': '2026-11-25T20:00:00Z' }; st0.seen = { bbbbbbbbbb1: 'old', bbbbbbbbbb2: 'old' }; st0.queue = {};
  N.saveState(st0);
  const items = [{ id: 'bbbbbbbbbb1', t: 'song 1', p: '2026-10-01T10:00:00Z' }, { id: 'bbbbbbbbbb2', t: 'song 2', p: '2026-09-01T10:00:00Z' }];
  const fetch = async u => String(u).includes('results?') ? { ok: true, text: async () => '"channelRenderer":{"channelId":"UCxxxxxxxxxxxxxxxxxxxxxx","title":{"simpleText":"Singer"}}' } : { ok: true, text: async () => feed('Singer', items) };
  await N.pollOnce({ fetch, topics: ['3'], force: true, searchesPerRound: 100, searchGapMs: 0 }, now);
  const st = N.loadState();
  assert.ok(st.queue.bbbbbbbbbb1 && st.queue.bbbbbbbbbb2, 'the skipped songs are queued now');
  // Not again on the next round.
  delete st.queue.bbbbbbbbbb1; st.seen.bbbbbbbbbb1 = 'old'; N.saveState(st);
  await N.pollOnce({ fetch, topics: ['3'], force: true, searchesPerRound: 100, searchGapMs: 0 }, now + 3600e3);
  assert.ok(!N.loadState().queue.bbbbbbbbbb1);
});

test('files of a channel taken out of a topic are removed once', async () => {
  const N = await import('../news-ext11.js');
  const io = fakeYemot();
  io.json.set('ivr2:/2/youtubeaudio/news11_t4_index.json', { version: 1, next: 2, archives: 0, items: { v1: { dir: '/11/4', file: '000', ch: 'y4pc' }, v2: { dir: '/11/4', file: '001', ch: 'hwzone' } } });
  io.files.set('ivr2:/11/4/000.wav', 'a'); io.files.set('ivr2:/11/4/001.wav', 'b');
  const st = { queue: { v3: { topic: '4', ch: 'y4pc' } }, seen: {} };
  assert.equal(await N.removeDroppedChannels(io, st), 1);
  assert.ok(!io.files.has('ivr2:/11/4/000.wav') && io.files.has('ivr2:/11/4/001.wav'));
  assert.ok(!st.queue.v3);
});

test('an English channel is published in spoken Hebrew; an already-Hebrew one as it is', async () => {
  N._resetForTests();
  const io = fakeYemot();
  const st = N.loadState(); st.queue = { eeeeeeeeee1: { topic: '5', ch: 'united24', chTitle: 'UNITED24', dub: true, title: 'Report', published: new Date().toISOString(), tries: 0, nextAt: 0 } }; N.saveState(st);
  const mastered = [];
  const deps = { log: { info() {}, warn() {} }, probe: async () => ({ live: 'not_live', durationSec: 120 }), busy: () => false,
    download: async (v, out) => { writeFileSync(out, 'src'); },
    dub: async (src, out) => { const f = out.replace(/\.m4a$/, '.flac'); writeFileSync(f, 'he'); return { state: 'done', file: f }; },
    master: async (src, out) => { mastered.push(path.basename(src)); writeFileSync(out, 'wav'); return { durationSec: 120 }; },
    publish: (v, w, m) => N.publishNews(v, w, m, io) };
  await (await N.workOnce(deps)).done;
  assert.deepEqual(mastered, ['dub.flac']);
  const idx = await io.readJson('ivr2:/2/youtubeaudio/news11_t5_index.json');
  assert.equal(idx.items.eeeeeeeeee1.title, 'Report - מתורגם לעברית');
  assert.ok(io.files.has('ivr2:/11/1/2/000.wav'));
});

test('LobbyTube topics: the shipped lists make 11/5 on, Torah joins 11/2, its news topic is left out', async () => {
  const N = await import('../news-ext11.js');
  const byTitle = t => Object.keys(N.TOPICS).find(k => N.TOPICS[k].title === t);
  assert.equal(N.topicDir(byTitle('חדשות מוזיקה')), '/11/5');
  assert.equal(N.topicDir(byTitle('כללי')), '/11/36');
  assert.ok(N.TOPICS.T2.channels.some(c => c.lobby) && N.TOPICS['2'].channels.some(c => c.key === 'yedid') && !N.TOPICS['2'].channels.some(c => c.lobby));
  assert.equal(N.topicDir('T2'), '/11/2/2');
  assert.ok(!byTitle('חדשות ואקטואליה'));
  assert.deepEqual(N.topicOfDir('/11/6'), { t: byTitle('מעניין'), a: 0 });
  const id = n => 'UC' + String(n).padStart(22, 'x');
  const r = N.importLobby({ order: ['ילדים'], cats: { 'ילדים': [id(5), 'bad'] } });
  assert.equal(r.channels, 1);
});

test('a later import of one LobbyTube topic keeps every folder number', async () => {
  const N = await import('../news-ext11.js');
  const id = n => 'UC' + String(n).padStart(22, 'y');
  const before = Object.fromEntries(Object.keys(N.TOPICS).map(k => [N.TOPICS[k].title, N.topicDir(k)]));
  N.importLobby({ order: ['הישרדות', 'נושא חדש'], cats: { 'הישרדות': [id(1)], 'נושא חדש': [id(2)] } });
  const after = Object.fromEntries(Object.keys(N.TOPICS).map(k => [N.TOPICS[k].title, N.topicDir(k)]));
  for (const [t, d] of Object.entries(before)) assert.equal(after[t], d, t);
  assert.equal(after['נושא חדש'], '/11/37');
});

test('channels moved from 11/1/1 to 11/1/2 take their files, once', async () => {
  N._resetForTests();
  const io = fakeYemot();
  io.files.set('ivr2:/11/1/1/000.wav', 'a'); io.files.set('ivr2:/11/1/1/001.wav', 'b');
  await io.writeJson(N.INDEX, { next: 2, layout: 'main-part', items: { r000000000a: { dir: '/11/1/1', file: '000', ch: 'reshet13' }, k000000000b: { dir: '/11/1/1', file: '001', ch: 'kan' } } });
  await io.writeJson('ivr2:/2/youtubeaudio/news11_t5_index.json', { next: 7, items: {} });
  const st = { queue: { q000000000c: { topic: '1', ch: 'ch24' } } };
  assert.equal(await N.moveChannelFiles(io, st), 1);
  assert.equal(io.files.get('ivr2:/11/1/2/007.wav'), 'a');
  assert.ok(io.files.has('ivr2:/11/1/1/001.wav'));
  assert.equal(st.queue.q000000000c.topic, '5');
  assert.equal((await N.lookupNews('/11/1/2', '007', io)).videoId, 'r000000000a');
  assert.equal(await N.moveChannelFiles(io, st), 0);
});

test('11/2 splits: its files go to 11/2/1, the LobbyTube channels\' files to 11/2/2', async () => {
  N._resetForTests();
  const io = fakeYemot();
  io.files.set('ivr2:/11/2/000.wav', 'mine'); io.files.set('ivr2:/11/2/001.wav', 'lobby');
  await io.writeJson('ivr2:/2/youtubeaudio/news11_t2_index.json', { next: 2, items: { y000000000a: { dir: '/11/2', file: '000', ch: 'yedid' }, l000000000b: { dir: '/11/2', file: '001', ch: 'lb_UCabc' } } });
  await N.moveNewsToMainPart(io, '2', '/11/2');
  await N.moveChannelFiles(io, { queue: {} });
  assert.equal(io.files.get('ivr2:/11/2/1/000.wav'), 'mine');
  assert.equal(io.files.get('ivr2:/11/2/2/000.wav'), 'lobby');
  assert.equal((await N.lookupNews('/11/2/2', '000', io)).videoId, 'l000000000b');
  assert.deepEqual(N.topicOfDir('/11/2/2'), { t: 'T2', a: 0 });
});

test('news: the newest video goes first, main news before other news; chosen Torah has its own lane', async () => {
  N._resetForTests();
  const st = N.loadState();
  st.queue = {
    old0000000a: { topic: '5', ch: 'srugim', title: 'old other', published: '2026-11-20T10:00:00Z' },
    new0000000b: { topic: '1', ch: 'kikar', title: 'new main', published: '2026-11-27T10:00:00Z' },
    mid0000000c: { topic: '1', ch: 'kikar', title: 'older main', published: '2026-11-26T10:00:00Z' },
    tor0000000d: { topic: '2', ch: 'yedid', title: 'lesson', published: '2026-11-27T09:00:00Z' },
  };
  N.saveState(st);
  const order = [];
  const deps = { log: { info() {}, warn() {} }, busy: () => true, probe: async v => { order.push(v); return { live: 'is_upcoming' }; } };
  await (await N.workOnce(deps)).done;
  assert.deepEqual(order.sort(), ['new0000000b', 'tor0000000d'].sort());
});

test('a busy moment in Yemot never empties a list: key 8 still finds the file, and nothing is written over it', async () => {
  const io = fakeYemot(); io.indexRetryWaits = [0, 0, 0];
  await io.writeJson(N.INDEX, { next: 2, items: { aaaaaaaaaaa: { dir: N.TOPICS['1'].dir, file: '001', title: 'כותרת' } } });
  const real = io.readJson; let fails = 2;
  io.readJson = async x => { if (fails-- > 0) throw new Error('busy'); return real(x); };
  assert.equal((await N.lookupNews(N.TOPICS['1'].dir, '001', io)).videoId, 'aaaaaaaaaaa');
  io.readJson = async () => { throw new Error('busy'); };
  assert.equal((await N.lookupNews(N.TOPICS['1'].dir, '001', io)).videoId, 'aaaaaaaaaaa', 'the last good copy');
  await assert.rejects(N.publishNews('bbbbbbbbbbb', '/tmp/x.wav', { title: 't' }, io));
  io.readJson = real;
  assert.ok((await io.readJson(N.INDEX)).items.aaaaaaaaaaa, 'the list was not written over');
});

test('the shared lanes go round the folders in turn (a folder with hundreds waiting never takes every turn)', async () => {
  N._resetForTests();
  const lob = Object.keys(N.TOPICS).find(k => N.TOPICS[k].lobby);
  assert.ok(lob, 'LobbyTube folders exist');
  const st = N.loadState(); st.queue = {}; st.turn = {}; st.perDay = {};
  const pub = new Date().toISOString();
  for (let i = 0; i < 30; i++) st.queue['m' + String(i).padStart(10, '0')] = { topic: '3', title: 'm' + i, published: pub, nextAt: 0 };
  st.queue.lobbyvideo1 = { topic: lob, lobby: true, maxAgeDays: 3, title: 'l', published: pub, nextAt: 0 };
  N.saveState(st);
  const started = [];
  const deps = { busy: () => false, log: { info() {}, warn() {} }, probe: async v => { started.push(v); return { live: 'is_upcoming' }; } };
  await (await N.workOnce(deps)).done;
  assert.ok(started.includes('lobbyvideo1'), 'the LobbyTube folder got a turn at once: ' + started.join(','));
  assert.equal(started.filter(v => v.startsWith('m')).length, 1, 'music got one turn, not both lanes');
  assert.ok(Object.keys(N.loadState().queue).filter(v => v.startsWith('m')).length <= 25, 'a folder keeps at most 25 waiting');
});

test('live check by the YouTube Data API', () => {
  assert.deepEqual(N.liveFromApi({ snippet: { liveBroadcastContent: 'live' } }), { live: 'is_live', durationSec: null });
  assert.deepEqual(N.liveFromApi({ snippet: { liveBroadcastContent: 'upcoming' } }), { live: 'is_upcoming', durationSec: null });
  assert.deepEqual(N.liveFromApi({ snippet: { liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT1H2M3S' } }), { live: 'not_live', durationSec: 3723 });
  assert.deepEqual(N.liveFromApi({ snippet: { liveBroadcastContent: 'none' }, contentDetails: { duration: 'P0D' }, liveStreamingDetails: { actualEndTime: 'x' } }), { live: 'post_live', durationSec: null });
  assert.equal(N.liveFromApi(undefined).gone, true);
});
