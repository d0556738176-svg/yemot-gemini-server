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
