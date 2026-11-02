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

const fakeFetch = (seconds) => async () => ({
  ok: true,
  json: async () => ({ items: [{ contentDetails: { duration: 'PT' + seconds + 'S' } }] })
});
const env = { BRANCH2_NATIVE_AUDIO_ENGINE: 'off', YOUTUBE_API_KEY: 'k', BRANCH2_ENGINE_LENGTH_THRESHOLD_SEC: '600' };

test('short video routes to s-r', async () => {
  const r = await pickApifyActor('abcdef12345', env, fakeFetch(300));
  assert.match(r.actor, /^s-r\//);
  assert.equal(r.reason, 'short');
});

test('long video routes to memo23', async () => {
  const r = await pickApifyActor('abcdef12345', env, fakeFetch(5400));
  assert.match(r.actor, /^memo23\//);
  assert.equal(r.reason, 'long');
});

test('unknown length falls back to the long/flat actor', async () => {
  const r = await pickApifyActor('abcdef12345', env, async () => ({ ok: false }));
  assert.match(r.actor, /^memo23\//);
  assert.equal(r.reason, 'unknown_length');
});

test('routing can be disabled', async () => {
  const r = await pickApifyActor('abcdef12345', { ...env, BRANCH2_ENGINE_ROUTING: 'off' }, fakeFetch(60));
  assert.match(r.actor, /^memo23\//);
  assert.equal(r.reason, 'routing_off');
});

test('threshold boundary is inclusive for short', async () => {
  const r = await pickApifyActor('abcdef12345', env, fakeFetch(600));
  assert.equal(r.reason, 'short');
});

