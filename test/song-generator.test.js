import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSongRequest, generateSongSpec, buildCompositionPlan } from '../song-generator.js';

test('song requests are bounded to 30-60 seconds', () => {
  assert.equal(normalizeSongRequest({ prompt: 'שיר', duration_seconds: 10 }).durationSeconds, 30);
  assert.equal(normalizeSongRequest({ prompt: 'שיר', duration_seconds: 120 }).durationSeconds, 60);
  assert.equal(normalizeSongRequest({ prompt: 'שיר' }).durationSeconds, 45);
});

test('composition plan contains structured chunks with valid durations', () => {
  const spec = {
    title: 'לילה בעיר', genre: 'pop', mood: 'upbeat', tempo: '110 BPM',
    musicPrompt: 'upbeat pop, warm synths', durationSeconds: 45,
    lyrics: '[Intro]\nלילה נדלק\n[Verse 1]\nהאורות רצים איתי\n[Chorus]\nנוסעים עד האור'
  };
  const plan = buildCompositionPlan(spec);
  assert.ok(plan.chunks.length >= 2);
  assert.ok(plan.chunks.every(chunk => chunk.duration_ms >= 3000));
  assert.ok(plan.chunks.every(chunk => Array.isArray(chunk.positive_styles)));
  assert.ok(plan.chunks[0].text.includes('Intro'));
});

test('lyrics generator accepts a valid structured JSON response', async () => {
  const spec = await generateSongSpec(
    { prompt: 'שיר קצבי על נסיעה בלילה' },
    async prompt => {
      assert.match(prompt, /JSON/);
      return JSON.stringify({
        title: 'אורות בדרך', language: 'he', genre: 'pop', mood: 'energetic',
        tempo: '110 BPM', duration_seconds: 45,
        lyrics: '[Verse 1]\nהאורות רצים בדרך\n[Chorus]\nהלילה שר איתי',
        music_prompt: 'upbeat Hebrew pop, synth bass, bright drums',
        needs_clarification: false
      });
    }
  );
  assert.equal(spec.title, 'אורות בדרך');
  assert.equal(spec.language, 'he');
  assert.ok(spec.lyrics.includes('הלילה שר איתי'));
  assert.equal(spec.durationSeconds, 45);
});

test('unclear request returns a clarification instead of guessing', async () => {
  const spec = await generateSongSpec(
    { prompt: 'שיר' },
    async () => JSON.stringify({
      needs_clarification: true,
      clarification_question: 'איזה סגנון מוזיקלי תרצה?'
    })
  );
  assert.equal(spec.needsClarification, true);
  assert.match(spec.clarificationQuestion, /סגנון/);
});

test('invalid LLM JSON is rejected', async () => {
  await assert.rejects(
    generateSongSpec({ prompt: 'שיר קצבי' }, async () => 'not json'),
    /valid JSON/
  );
});
