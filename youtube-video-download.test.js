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
