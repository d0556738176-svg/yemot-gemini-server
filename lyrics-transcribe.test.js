import test from 'node:test';
import assert from 'node:assert/strict';
import { wordsToLines } from './lyrics-transcribe.js';
import { downloadMetadata } from './youtube-cover-art.js';
test('transcribed words become lines at pauses and sentence ends', () => {
  const w = (word, start, end) => ({ word, start, end });
  assert.deepEqual(wordsToLines([w('אמונה', 0, .5), w('היא', .5, .8), w('הדלק.', .8, 1.2), w('בכל', 3, 3.3), w('יום', 3.3, 3.6)]), ['אמונה היא הדלק.', 'בכל יום']);
});
test('date tag is the plain day; the exact time stays in the comment', () => {
  const m = downloadMetadata('abcdefghijk', { title: 't', channel: 'c', publishedAt: '2011-10-04T10:45:40Z' });
  assert.equal(m.date, '2011-10-04'); assert.equal(m.year, '2011'); assert.match(m.comment, /בשעה/);
});
