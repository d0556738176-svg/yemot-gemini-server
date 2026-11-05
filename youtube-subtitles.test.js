import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCues, toSrt, srtTime, translateCues } from './youtube-subtitles.js';

test('words become short timed cues and valid SRT', () => {
  const words = [];
  for (let i = 0; i < 30; i++) words.push({ start: i * 0.4, end: i * 0.4 + 0.3, punctuated_word: i === 9 ? 'end.' : 'w' + i });
  const cues = buildCues(words);
  assert.ok(cues.length >= 2);
  assert.equal(cues[0].text.split(' ').length, 10);
  for (const c of cues) assert.ok(c.end > c.start);
  assert.equal(srtTime(3661.5), '01:01:01,500');
  assert.match(toSrt(cues), /^1\n00:00:00,000 --> 00:00:0\d,\d{3}\nw0 /);
});

test('translation keeps timing and count; falls back to Groq', async () => {
  const cues = [{ start: 0, end: 1, text: 'Hello' }, { start: 1, end: 2, text: 'World' }];
  const fetchImpl = async (url) => {
    if (String(url).includes('generativelanguage')) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '["שלום","עולם"]' } }] }), { status: 200 });
  };
  const r = await translateCues(cues, { env: { GEMINI_API_KEYS: 'k', GROQ_API_KEY: 'g' }, fetchImpl, log: {} });
  assert.equal(r.translated, 2);
  assert.deepEqual(r.cues.map(c => c.text), ['שלום', 'עולם']);
  assert.equal(r.cues[1].start, 1);
});
