import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSongRequest, generateSongSpec, buildCompositionPlan, shouldFallbackToBackup } from '../song-generator.js';

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
  assert.ok(plan.sections.length >= 2);
  assert.ok(plan.sections.every(section => section.duration_ms >= 3000));
  assert.equal(plan.sections.reduce((sum, section) => sum + section.duration_ms, 0), 45000);
  assert.ok(plan.sections.every(section =>
    typeof section.section_name === 'string' &&
    Array.isArray(section.lines) &&
    Array.isArray(section.positive_local_styles) &&
    Array.isArray(section.negative_local_styles)
  ));
  assert.equal(plan.sections[0].section_name, 'Intro');
  assert.ok(plan.sections[0].lines.includes('לילה נדלק'));
  assert.ok(Array.isArray(plan.positive_global_styles));
  assert.ok(Array.isArray(plan.negative_global_styles));
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


test('provider router falls back for auth, quota, timeout and availability failures', () => {
  for (const status of [0, 401, 403, 404, 408, 429, 500, 502, 503, 504]) {
    assert.equal(shouldFallbackToBackup(status), true, `expected fallback for HTTP ${status}`);
  }
});

test('provider router does not retry clearly invalid generation requests', () => {
  for (const status of [400, 413, 422]) {
    assert.equal(shouldFallbackToBackup(status), false, `expected fail-fast for HTTP ${status}`);
  }
});
