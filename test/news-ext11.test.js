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
    readJson: async x => { if (!json.has(x)) throw new Error('none'); return structuredClone(json.get(x)); },
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
  assert.ok(io.files.has('ivr2:/11/1/000.wav'));
  const { existsSync } = await import('node:fs');
  assert.ok(seenTmp.every(d => !existsSync(d)), 'temporary folder deleted');
  assert.match(io.ini.get('/11/1'), /control_play2=send_api/);
  assert.match(io.ini.get('/11/1'), /start=max/);
});

test('full folder: the older half goes to the archive, the newer half moves down', async () => {
  N._resetForTests();
  const io = fakeYemot();
  const items = {};
  for (let n = 0; n < 1000; n++) { io.files.set('ivr2:/11/1/' + N.file3(n) + '.wav', 'f' + n); items['v' + String(n).padStart(10, '0')] = { dir: '/11/1', file: N.file3(n), title: 't' + n }; }
  await io.writeJson(N.INDEX, { version: 1, next: 1000, items, archives: 0 });
  const e = await N.publishNews('newvideo123', '/tmp/x.wav', { title: 'newest' }, io);
  assert.equal(e.file, '500');
  assert.equal(io.files.get('ivr2:/11/1/1/000.wav'), 'f0');
  assert.equal(io.files.get('ivr2:/11/1/1/499.wav'), 'f499');
  assert.equal(io.files.get('ivr2:/11/1/000.wav'), 'f500');
  assert.equal(io.files.get('ivr2:/11/1/499.wav'), 'f999');
  const idx = await io.readJson(N.INDEX);
  assert.equal(idx.archives, 1); assert.equal(idx.next, 501);
  assert.deepEqual(await N.lookupNews('/11/1', '000', io), { videoId: 'v0000000500', title: 't500', dub: false, channel: '' });
  assert.equal((await N.lookupNews('/11/1/1', '499', io)).videoId, 'v0000000499');
  assert.match(io.ini.get('/11/1/1'), /type=playfile/);
});

test('key 2: asks 1/2; 1 deletes and plays the next older file; 2 cancels', async () => {
  N._resetForTests();
  const io = fakeYemot();
  for (const n of [0, 1, 2]) io.files.set('ivr2:/11/1/00' + n + '.wav', 'x');
  await io.writeJson(N.INDEX, { next: 3, items: { a0000000000: { dir: '/11/1', file: '000' }, a0000000001: { dir: '/11/1', file: '001' }, a0000000002: { dir: '/11/1', file: '002' } } });
  const deps = { lookup: (d, f) => N.lookupNews(d, f, io), canDelete: d => /^\/11\/[1-9]$/.test(d), deleteFile: (d, f) => N.deleteNews(d, f, io) };
  const ask = await K.handleMediaKey({ what: 'ivr2:/11/1/001.wav', PlayStop: '5000', PressKey: '2' }, deps, { info() {}, warn() {} });
  assert.match(ask, /^read=.*=del_ok,/);
  const no = await K.handleMediaKey({ what: 'ivr2:/11/1/001.wav', PlayStop: '5000', del_ok: '2' }, deps, { info() {}, warn() {} });
  assert.match(no, /go_to_folder_and_play=\/11\/1,001,5000/); assert.ok(io.files.has('ivr2:/11/1/001.wav'));
  const yes = await K.handleMediaKey({ what: 'ivr2:/11/1/001.wav', PlayStop: '5000', del_ok: '1' }, deps, { info() {}, warn() {} });
  assert.ok(!io.files.has('ivr2:/11/1/001.wav'));
  assert.match(yes, /go_to_folder_and_play=\/11\/1,000,0/);
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
  assert.ok(io.files.has('ivr2:/11/2/000.wav')); assert.ok(io.files.has('ivr2:/11/2/001.wav')); assert.ok(io.files.has('ivr2:/11/3/000.wav'));
  assert.ok(!io.files.has('ivr2:/11/1/000.wav'));
  assert.equal((await N.lookupNews('/11/2', '000', io)).videoId, 'torahvideo1');
  const site = await N.lookupNews('/11/2', '001', io);
  assert.equal(site.videoId, null); assert.match(site.url, /objectstorage/);
  assert.deepEqual(N.topicOfDir('/11/3/2'), { t: '3', a: 2 }); assert.equal(N.topicOfDir('/11/7'), null);
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
