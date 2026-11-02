import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIsoDurationSeconds, pickApifyActor } from './youtube-engine-select.js';

test('parses ISO-8601 durations', () => {
  assert.equal(parseIsoDurationSeconds('PT4M13S'), 253);
  assert.equal(parseIsoDurationSeconds('PT1H2M3S'), 3723);
  assert.equal(parseIsoDurationSeconds('PT2H'), 7200);
  assert.equal(parseIsoDurationSeconds('P0D'), null);
  assert.equal(parseIsoDurationSeconds('garbage'), null);
});

test('every video, whatever its length or settings, uses only the native engine', async () => {
  for (const env of [{}, { BRANCH2_NATIVE_AUDIO_ENGINE: 'off', BRANCH2_APIFY_ACTOR: 'memo23/youtube-video-downloader',
    BRANCH2_NATIVE_FALLBACK_ACTOR: 's-r/youtube-video-downloader', YOUTUBE_API_KEY: 'k' }]) {
    const r = await pickApifyActor('abcdef12345', env, () => { throw Error('no duration lookup needed'); });
    assert.equal(r.actor, 'johnvc/youtube-download-api');
    assert.equal(r.fallback, null);
  }
});
