import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedResultIndex, isMoreResultsRequest, isFreshYouTubeSearch } from './youtube-selection.js';

const results = [
  { title: 'חדשות הטכנולוגיה השבוע', channelTitle: 'ערוץ טכנולוגיה' },
  { title: 'מדריך מלא למחשב חדש', channelTitle: 'המדריך הישראלי' },
  { title: 'סקירת מחשבים חדשים', channelTitle: 'טק ישראל' }
];

test('selects by Hebrew ordinal and number', () => {
  assert.equal(selectedResultIndex('תשמיע לי את הראשון', results), 0);
  assert.equal(selectedResultIndex('אני רוצה תוצאה מספר 2', results), 1);
  assert.equal(selectedResultIndex('את השלישי בבקשה', results), 2);
});

test('selects by distinctive title words', () => {
  assert.equal(selectedResultIndex('אני רוצה מדריך מלא למחשב', results), 1);
  assert.equal(selectedResultIndex('תשמיע סקירת מחשבים חדשים', results), 2);
});

test('does not guess ambiguous speech', () => {
  assert.equal(selectedResultIndex('תשמיע לי סרטון', results), -1);
  assert.equal(selectedResultIndex('מספר 9', results), -1);
});

test('recognizes paging and fresh search', () => {
  assert.equal(isMoreResultsRequest('תביא עוד תוצאות'), true);
  assert.equal(isFreshYouTubeSearch('חיפוש חדש על מחשבים'), true);
});
