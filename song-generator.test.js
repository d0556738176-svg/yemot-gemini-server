import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAceStepPayload, normalizeSongRequest } from './song-generator.js';

test('ACE-Step payload preserves requested Hebrew lyrics and voice language', () => {
  const payload = buildAceStepPayload({
    title: 'נסיעה בלילה',
    language: 'he',
    lyrics: '[בית ראשון]\nאורות בעיר',
    genre: 'פופ קצבי',
    mood: 'אנרגטי',
    tempo: 'מהיר',
    musicPrompt: 'Hebrew pop, energetic, clear lead vocals',
    durationSeconds: 45
  });
  assert.equal(payload.lyrics, '[בית ראשון]\nאורות בעיר');
  assert.equal(payload.vocal_language, 'he');
  assert.equal(payload.audio_duration, 45);
  assert.equal(payload.task_type, 'text2music');
  assert.equal(payload.audio_format, 'mp3');
  assert.equal(payload.batch_size, 1);
});

test('ACE-Step payload clamps duration to the IVR-safe range', () => {
  assert.equal(buildAceStepPayload({ durationSeconds: 5 }).audio_duration, 30);
  assert.equal(buildAceStepPayload({ durationSeconds: 900 }).audio_duration, 60);
});

test('song request normalization limits caller input length', () => {
  const request = normalizeSongRequest({ prompt: 'א'.repeat(1000), duration_seconds: 45 });
  assert.equal(request.prompt.length, 700);
  assert.equal(request.durationSeconds, 45);
});

test('ACE-Step adapter submits, polls, and downloads audio using authenticated API calls', async () => {
  const previous = {
    url: process.env.ACESTEP_API_URL,
    key: process.env.ACESTEP_API_KEY,
    timeout: process.env.SONG_GENERATION_TIMEOUT_MS,
    fetch: globalThis.fetch
  };
  const calls = [];
  process.env.ACESTEP_API_URL = 'https://ace-step.example.test';
  process.env.ACESTEP_API_KEY = 'unit-test-secret';
  process.env.SONG_GENERATION_TIMEOUT_MS = '30000';
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: options.method || 'GET', authorization: options.headers?.authorization });
    if (url.pathname === '/release_task') {
      return new Response(JSON.stringify({ data: { task_id: 'task-123' }, code: 200, error: null }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (url.pathname === '/query_result') {
      return new Response(JSON.stringify({
        data: [{ task_id: 'task-123', status: 1, result: JSON.stringify([{ file: '/v1/audio?path=%2Ftmp%2Fsong.mp3' }]) }],
        code: 200, error: null
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/v1/audio') {
      return new Response(Buffer.from('mock-mp3-bytes'), {
        status: 200, headers: { 'content-type': 'audio/mpeg' }
      });
    }
    throw new Error('Unexpected mock URL: ' + url.pathname);
  };
  try {
    const result = await (await import('./song-generator.js')).generateWithAceStep({
      musicPrompt: 'Hebrew pop, clear vocals',
      lyrics: 'מילים לבדיקה',
      language: 'he',
      durationSeconds: 30,
      genre: 'pop',
      mood: 'upbeat'
    });
    assert.equal(result.provider, 'ace-step');
    assert.equal(result.contentType, 'audio/mpeg');
    assert.equal(result.audio.toString(), 'mock-mp3-bytes');
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/release_task', '/query_result', '/v1/audio']);
    assert.ok(calls.every(call => call.authorization === 'Bearer unit-test-secret'));
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      ACESTEP_API_URL: previous.url,
      ACESTEP_API_KEY: previous.key,
      SONG_GENERATION_TIMEOUT_MS: previous.timeout
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
