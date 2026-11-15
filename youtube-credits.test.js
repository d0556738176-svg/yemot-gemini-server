import test from 'node:test';
import assert from 'node:assert/strict';
import { descriptionCredits, downloadMetadata } from './youtube-cover-art.js';

const desc = 'קראתי אליך - בר צברי\nמילים: בר צברי | לחן: בר צברי\n\nעיבוד והפקה מוזיקלית: רון בקאל\n\n━━━━━━\nמילות השיר:\n━━━━━━\nשורה אחת\nשורה שתיים\n\nשורה שלוש\nשורה ארבע\n\n━━━━━━\nקרדיטים:\nשיר: קראתי אליך\nביצוע: בר צברי\nהפקה/זכויות: לבעלי הזכויות';

test('singer, song, words, tune and lyrics come from the labelled description lines', () => {
  const c = descriptionCredits(desc);
  assert.equal(c.artist, 'בר צברי');
  assert.equal(c.title, 'קראתי אליך');
  assert.equal(c.lyricist, 'בר צברי');
  assert.equal(c.composer, 'בר צברי');
  assert.equal(c.arranger, 'רון בקאל');
  assert.equal(c.lyrics, 'שורה אחת\nשורה שתיים\n\nשורה שלוש\nשורה ארבע');
});

test('the file details use them, the channel stays the album', () => {
  const m = downloadMetadata('b6sxoxWPKgI', { title: 'קראתי אליך - בר צברי | בר קריוקי', channel: 'בר קריוקי', description: desc, publishedAt: '2026-10-14T23:57:14Z', categoryId: '10' });
  assert.equal(m.title, 'קראתי אליך');
  assert.equal(m.artist, 'בר צברי');
  assert.equal(m.album, 'בר קריוקי');
  assert.equal(m.year, '2026');
  assert.match(m.comment, /בר קריוקי \|/);
  assert.match(m.lyrics, /שורה ארבע/);
});

test('a description with no labels keeps the old details', () => {
  const m = downloadMetadata('abcdefghijk', { title: 'שיעור בגמרא', channel: 'ערוץ', description: 'שיעור מרתק על מסכת ברכות' });
  assert.equal(m.title, 'שיעור בגמרא');
  assert.equal(m.artist, 'ערוץ');
  assert.equal(m.lyrics, undefined);
});
