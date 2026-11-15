import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, Worker, sources, scanChannel } from './core.mjs';
import { freeDownloader, yemotClient, youtubeAPI } from './adapters.mjs';

const source = sources[0];
const entry = (id, published, extra = {}) => ({ snippet: { title: 'clip', ...extra }, contentDetails: { videoId: id, videoPublishedAt: new Date(published).toISOString() } });
const memory = () => new Store(':memory:', 1000);
const item = (id, published = 2000) => ({ id, published, source: source.key, title: 'clip' });

test('uploads discovery includes Shorts and one-second clips, never backfills old archives, and deduplicates', async () => {
  const store = memory();
  store.setChannel(source.key, { playlist: 'uploads' });
  const api = async () => ({ items: [entry('shorts12345', 3000, { duration: 1 }), entry('normal12345', 2000), entry('oldvid12345', 999)] });
  await scanChannel(store, source, api, { now: 4000 });
  await scanChannel(store, source, api, { now: 5000 });
  assert.equal(store.stats()[0].count, 2);
  assert.equal(sources.length, 8);
  store.close();
});

test('pagination survives a budget boundary and a transient API failure without losing items', async () => {
  const store = memory(); store.setChannel(source.key, { playlist: 'uploads' });
  await scanChannel(store, source, async () => ({ items: [entry('first123456', 2000)], nextPageToken: 'page2' }), { pageBudget: 1, now: 5000 });
  assert.equal(store.channel(source.key).cursor, 'page2');
  assert.equal(store.channel(source.key).boundary, 1000);
  await assert.rejects(scanChannel(store, source, async () => { throw Error('network'); }));
  assert.equal(store.channel(source.key).cursor, 'page2');
  await scanChannel(store, source, async (_method, params) => {
    assert.equal(params.pageToken, 'page2'); return { items: [entry('second12345', 1500)] };
  }, { now: 6000 });
  assert.equal(store.channel(source.key).boundary, 5000);
  assert.equal(store.stats()[0].count, 2); store.close();
});

test('restart preserves deduplication and recovers interrupted work only on explicit worker recovery', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'news-test-'));
  try {
    const file = path.join(dir, 'state.sqlite');
    let store = new Store(file, 1000); store.add(item('persist1234')); store.begin('persist1234'); store.close();
    store = new Store(file, 9999); assert.equal(store.activated(), 1000);
    assert.equal(store.next(), undefined); store.recover(); store.add(item('persist1234'));
    assert.equal(store.stats()[0].count, 1); assert.equal(store.next().id, 'persist1234'); store.close();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('listing uses publication order rather than completion order and has stable session pagination', async () => {
  const store = memory(); store.add(item('newest12345', 3000)); store.add(item('older123456', 2000));
  store.ready('newest12345', ['/5/news/newest12345-00000']);
  store.ready('older123456', ['/5/news/older123456-00000']);
  assert.equal(store.latest()[0].id, 'newest12345');
  assert.equal(store.latest('', 1, 1)[0].id, 'older123456');
  assert.throws(() => store.ready('older123456', ['/2/existing'])); store.close();
});

test('overlapping ticks never start two downloads; unverified uploads never enter playback', async () => {
  const store = memory(); store.add(item('first123456')); store.add(item('second12345'));
  let finish, downloads = 0, cleaned = 0;
  const worker = new Worker(store, {
    download: async () => { downloads++; await new Promise(resolve => { finish = resolve; }); return { cleanup: async () => { cleaned++; } }; },
    publish: async () => { throw Error('verification_failed'); },
  });
  const pending = worker.tick(); await new Promise(r => setImmediate(r));
  await worker.tick(); assert.equal(downloads, 1); finish(); await pending;
  assert.equal(store.latest().length, 0); assert.equal(cleaned, 1); store.close();
});

test('load admission postpones work; failed items stop after three attempts and do not block another source', async () => {
  const store = memory(); store.add(item('failure1234'));
  let calls = 0;
  const worker = new Worker(store, { download: async () => { calls++; throw Error('blocked'); }, publish: async () => [], admit: async () => false });
  await worker.tick(); assert.equal(calls, 0);
  worker.admit = async () => true; worker.now = () => 10 ** 12;
  // Move the clock forward for every scheduled retry.
  for (let i = 0; i < 3; i++) { worker.now = () => (i + 1) * 10 ** 12; await worker.tick(); }
  assert.equal(store.stats()[0].status, 'failed'); assert.equal(calls, 3);
  store.add(item('another1234')); worker.download = async () => ({}); worker.publish = async () => ['/5/news/another1234-00000'];
  await worker.tick(); assert.equal(store.latest()[0].id, 'another1234'); store.close();
});

test('free downloader failure makes exactly one direct-module call and never asks for paid consent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'news-free-test-'));
  let calls = 0;
  try {
    const download = await freeDownloader({ workDir: dir, api: async () => ({ items: [{ snippet: { liveBroadcastContent: 'none' } }] }),
      downloadImpl: async (_id, _file, opts) => {
        calls++; assert.equal(opts.mode, 'audio'); assert.equal(opts.withCaptions, false);
        assert.equal('consentToFallback' in opts, false); assert.equal('paidConsent' in opts, false); throw Error('free_failed');
      } });
    await assert.rejects(download(item('failure1234')), /free_failed/);
    assert.equal(calls, 1); assert.deepEqual(await fs.readdir(dir), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('ongoing live streams wait for completion instead of recording indefinitely', async () => {
  let calls = 0;
  const download = await freeDownloader({ api: async () => ({ items: [{ snippet: { liveBroadcastContent: 'live' } }] }), downloadImpl: async () => { calls++; } });
  await assert.rejects(download(item('livevid1234')), { code: 'video_not_ready' }); assert.equal(calls, 0);
});

test('a long ongoing broadcast does not exhaust retries before its recording is available', async () => {
  const store = memory(); store.add(item('livevid1234'));
  const worker = new Worker(store, { download: async () => { throw Object.assign(Error('live'), { code: 'video_not_ready' }); }, publish: async () => [] });
  for (let i = 0; i < 4; i++) { worker.now = () => (i + 1) * 10 ** 12; await worker.tick(); }
  assert.equal(store.stats()[0].status, 'queued');
  assert.equal(store.next(10 ** 15).attempts, 0); store.close();
});

test('quota exhaustion uses no paid API and logs no credentials', async () => {
  let calls = 0;
  const api = youtubeAPI(['private-key'], async url => {
    calls++; assert.equal(url.hostname, 'www.googleapis.com'); return new Response('{}', { status: 403 });
  });
  await assert.rejects(api('channels', { part: 'snippet' }), /youtube_metadata_quota_or_key_missing/);
  await assert.rejects(api('channels', { part: 'snippet' })); assert.equal(calls, 1);
});

test('Yemot upload must be verified at exactly its original size before publication', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'news-upload-test-'));
  try {
    const file = path.join(dir, 'part.wav'); await fs.writeFile(file, Buffer.alloc(100));
    const requests = [];
    const client = yemotClient({ YEMOT_TOKEN: 'fixture' }, async url => {
      requests.push(url); return new Response(JSON.stringify({ responseStatus: 'OK', file: { exists: true, size: 50 } }));
    });
    await assert.rejects(client.publish(item('upload12345'), { files: [file] }), /upload_not_verified/);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(u => (u.searchParams.get('path') || u.searchParams.get('what')).startsWith('ivr2:/5/news/')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
