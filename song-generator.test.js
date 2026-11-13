import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAceStepPayload, buildCompositionPlan, normalizeSongRequest, shouldFallbackToBackup, classifyProviderFailure, YEMOT_AUDIO_CHUNK_SECONDS } from './song-generator.js';

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
  assert.equal(buildAceStepPayload({ durationSeconds: 210 }).audio_duration, 210);
  assert.equal(buildAceStepPayload({ durationSeconds: 900 }).audio_duration, 240);
});

test('song request normalization limits caller input length', () => {
  const request = normalizeSongRequest({ prompt: 'א'.repeat(1000), duration_seconds: 210 });
  assert.equal(request.prompt.length, 700);
  assert.equal(request.durationSeconds, 210);
});

test('song request defaults to 60 seconds (free CPU engine) and caps excessive durations', () => {
  assert.equal(normalizeSongRequest({ prompt: 'שיר לנסיעה' }).durationSeconds, 60);
  assert.equal(normalizeSongRequest({ prompt: 'שיר לנסיעה', duration_seconds: 999 }).durationSeconds, 240);
});

test('Yemot WAV chunks stay below the 90-second validation ceiling for full-length songs', () => {
  assert.equal(YEMOT_AUDIO_CHUNK_SECONDS, 60);
  assert.ok(YEMOT_AUDIO_CHUNK_SECONDS <= 90);
  assert.equal(Math.ceil(240 / YEMOT_AUDIO_CHUNK_SECONDS), 4);
});

test('composition plan allocates all requested time across lyric sections', () => {
  const plan = buildCompositionPlan({
    durationSeconds: 180, lyrics: '[Verse 1]\nשורה אחת\n[Chorus]\nפזמון\n[Verse 2]\nשורה נוספת',
    genre: 'pop', mood: 'upbeat', musicPrompt: 'Hebrew pop', tempo: 'mid-tempo'
  });
  assert.equal(plan.chunks.length, 3);
  assert.equal(plan.chunks.reduce((sum, chunk) => sum + chunk.duration_ms, 0), 180000);
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


test('provider failures use bounded cooldowns and recover after the cooldown', () => {
  assert.deepEqual(classifyProviderFailure(429), { status: 'rate_limited', cooldownMs: 60000 });
  assert.deepEqual(classifyProviderFailure(401), { status: 'disabled', cooldownMs: 60000 });
  assert.deepEqual(classifyProviderFailure(400), { status: 'disabled', cooldownMs: 30000 });
  assert.deepEqual(classifyProviderFailure(0), { status: 'temporary_error', cooldownMs: 15000 });
  assert.deepEqual(classifyProviderFailure(503), { status: 'temporary_error', cooldownMs: 15000 });
  assert.deepEqual(classifyProviderFailure(502, 'You have exceeded your free ZeroGPU quota (192s requested)'), { status: 'rate_limited', cooldownMs: 12 * 60 * 60 * 1000 });
});

test('backup is not attempted for invalid client payloads but can recover from provider outages', () => {
  assert.equal(shouldFallbackToBackup(400), false);
  assert.equal(shouldFallbackToBackup(413), false);
  assert.equal(shouldFallbackToBackup(422), false);
  assert.equal(shouldFallbackToBackup(429), true);
  assert.equal(shouldFallbackToBackup(503), true);
});

test('acemusic payload sends Hebrew lyrics with the style caption and a clamped duration', async () => {
  const { buildAceMusicPayload, decodeAceMusicResponse } = await import('./song-engine-acemusic.js');
  const p = buildAceMusicPayload({ lyrics: '[Verse 1]\nשבת שלום', musicPrompt: 'joyful, male vocals', language: 'he', durationSeconds: 999 }, {});
  assert.equal(p.lyrics, '[Verse 1]\nשבת שלום');
  assert.equal(p.messages[0].content, 'joyful, male vocals');
  assert.equal(p.audio_config.vocal_language, 'he');
  assert.equal(p.audio_config.duration, 240);
  assert.equal(p.audio_config.format, 'mp3');
  assert.equal(p.stream, false);
  const audio = Buffer.alloc(20000, 7);
  const out = decodeAceMusicResponse({ choices: [{ finish_reason: 'stop', message: { content: 'ok', audio: [{ type: 'audio_url', audio_url: { url: 'data:audio/mpeg;base64,' + audio.toString('base64') } }] } }] });
  assert.equal(out.audio.length, 20000);
  assert.equal(out.contentType, 'audio/mpeg');
  assert.throws(() => decodeAceMusicResponse({ choices: [{ finish_reason: 'error', message: { content: 'boom' } }] }), /boom/);
  assert.throws(() => decodeAceMusicResponse({ choices: [{ finish_reason: 'stop', message: { content: 'x', audio: [] } }] }), /no audio/);
});

test('acemusic adapter posts to the OpenRouter-compatible endpoint and returns the decoded song', async () => {
  const { generateWithAceMusic } = await import('./song-engine-acemusic.js');
  const audio = Buffer.alloc(30000, 3);
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '## Metadata', audio: [{ audio_url: { url: 'data:audio/mpeg;base64,' + audio.toString('base64') } }] } }] }), { status: 200 });
  };
  try {
    const r = await generateWithAceMusic({ lyrics: 'שלום', musicPrompt: 'pop', durationSeconds: 40 }, { ACE_MUSIC_API_KEY: 'k' });
    assert.equal(seen.url, 'https://api.acemusic.ai/v1/chat/completions');
    assert.equal(seen.init.headers.authorization, 'Bearer k');
    assert.equal(r.provider, 'acemusic');
    assert.equal(r.audio.length, 30000);
  } finally { globalThis.fetch = original; }
});
