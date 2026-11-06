import test from 'node:test';
import assert from 'node:assert/strict';
import { videoQualityFor, engineCosts } from './youtube-video-download.js';

test('quality by length keeps files a manageable size', () => {
  assert.equal(videoQualityFor(5 * 60), '1080p');
  assert.equal(videoQualityFor(45 * 60), '720p');
  assert.equal(videoQualityFor(3 * 3600), '480p');
  assert.equal(videoQualityFor(null), '720p');
});
test('the per-minute engine is cheaper than the flat one at every length', () => {
  for (const sec of [60, 3600, 12 * 3600]) {
    const c = engineCosts(sec);
    assert.ok(c['johnvc~youtube-download-api'] < c['memo23~youtube-video-downloader']);
  }
});

test('a start error on one key moves to the next key', async () => {
  const { _runEngine } = await import('./youtube-video-download.js');
  const mem = new Map(); const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url); const key = init.headers.authorization.slice(7); calls.push(key + ' ' + u.replace(/\?.*/, ''));
    if (init.method === 'POST') return key === 'k1' ? new Response('{"error":{"message":"boom"}}', { status: 500 }) : new Response('{"data":{"id":"run2"}}', { status: 201 });
    if (u.includes('/actor-runs/')) return new Response('{"data":{"status":"SUCCEEDED","defaultDatasetId":"d"}}', { status: 200 });
    return new Response(JSON.stringify([{ videoId: 'abcdefghijk', downloadUrl: 'https://files.example.com/v.mp4', resultType: 'file' }]), { status: 200 });
  };
  const got = await _runEngine('johnvc~youtube-download-api', 'abcdefghijk', '1080p', { tokens: ['k1', 'k2'], log: {}, store: { read: async x => mem.get(x), write: async (x, d) => mem.set(x, d) }, receiptPath: 'r', fetchImpl, sleep: async () => {} });
  assert.equal(got.runId, 'run2');
  assert.ok(calls.some(c => c.startsWith('k2 ')));
});
