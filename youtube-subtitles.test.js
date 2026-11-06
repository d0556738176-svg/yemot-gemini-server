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

test('Hebrew speech lines are proofread, count and timing kept', async () => {
  const { correctHebrewCues } = await import('./youtube-subtitles.js');
  const cues = [{ start: 0, end: 1, text: 'שלום לכלם' }, { start: 1, end: 2, text: 'פרשת השבו' }];
  const fetchImpl = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '["שלום לכולם","פרשת השבוע"]' }] } }] }), { status: 200 });
  const out = await correctHebrewCues(cues, { env: { GEMINI_API_KEYS: 'k' }, fetchImpl });
  assert.deepEqual(out.map(c => c.text), ['שלום לכולם', 'פרשת השבוע']);
  assert.equal(out[1].start, 1);
});

test('a failing group is split and every line still gets Hebrew', async () => {
  const { translateCues } = await import('./youtube-subtitles.js');
  const cues = Array.from({ length: 8 }, (_, i) => ({ start: i, end: i + 1, text: 'line ' + i }));
  // Gemini refuses groups bigger than 2 lines; Groq unavailable.
  const fetchImpl = async (url, opts) => {
    if (!String(url).includes('generativelanguage')) return new Response('{}', { status: 500 });
    const lines = JSON.parse(JSON.parse(opts.body).contents[0].parts[0].text);
    if (lines.length > 2) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(lines.map(l => 'עברית ' + l)) }] } }] }), { status: 200 });
  };
  const r = await translateCues(cues, { env: { GEMINI_API_KEYS: 'k', GROQ_API_KEY: '' }, fetchImpl, log: {}, maxWaitMs: 0 });
  assert.equal(r.translated, 8);
  assert.ok(r.cues.every(c => c.text.startsWith('עברית')));
});

test('backup transcription (Whisper) gives timed words', async () => {
  const { whisperTimed } = await import('./youtube-subtitles.js');
  const fsm = await import('node:fs/promises');
  await fsm.writeFile('/tmp/w.ogg', Buffer.from('x'));
  const fetchImpl = async () => new Response(JSON.stringify({ language: 'hebrew', words: [{ word: 'שלום', start: 0.1, end: 0.5 }, { word: 'לכולם', start: 0.6, end: 1.0 }] }), { status: 200 });
  const r = await whisperTimed('/tmp/w.ogg', { env: { GROQ_API_KEY: 'g' }, fetchImpl, log: {} });
  assert.equal(r.language, 'he');
  assert.equal(r.words.length, 2);
  assert.equal(r.words[1].punctuated_word, 'לכולם');
});
