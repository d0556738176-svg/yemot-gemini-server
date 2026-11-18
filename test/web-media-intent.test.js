import test from 'node:test';
import assert from 'node:assert/strict';
import { webSearchIntent } from '../web-media-intent.js';

test('a request to search the whole web for a recording is recognized', () => {
  assert.equal(webSearchIntent('תחפש לי באינטרנט שיעור של הרב אמנון יצחק על שבת'), 'שיעור של הרב אמנון יצחק על שבת');
  assert.equal(webSearchIntent('אני רוצה שתמצא לי בכל האתרים הקלטה של דרשה על פרשת השבוע'), 'הקלטה של דרשה על פרשת השבוע');
  assert.equal(webSearchIntent('תוריד לי מהאינטרנט סרטון על בניית סוכה'), 'סרטון על בניית סוכה');
});

test('ordinary questions are not sent to the web search', () => {
  assert.equal(webSearchIntent('מה מזג האוויר מחר'), null);
  assert.equal(webSearchIntent('תחפש באינטרנט מה שעות הפתיחה של הדואר'), null);
  assert.equal(webSearchIntent('תמצא לי ביוטיוב שיר של שוואקי'), null);
});

test('a live broadcast request keeps its words for extension 2', () => {
  assert.equal(webSearchIntent('תשמיע לי שידור חי של קול חי'), 'שידור חי של קול חי');
  assert.match(webSearchIntent('אני רוצה לשמוע את השידור החי מהכותל ביוטיוב'), /השידור החי מהכותל/);
  assert.match(webSearchIntent('תפתח לי לייב של הרב'), /לייב של הרב/);
});
