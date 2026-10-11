import test from 'node:test';
import assert from 'node:assert/strict';
import { rankWebsitePages } from '../website-relevance.js';

test('prioritizes the hours page over a long homepage for opening-hours requests', () => {
  const homepage = { url: 'https://example.co.il/', content: 'ברוכים הבאים. החברה מספקת מגוון רחב של מוצרים ושירותים. ' + 'מידע כללי '.repeat(200) };
  const hours = { url: 'https://example.co.il/branches/opening-hours', content: 'שעות פתיחה ושעות פעילות לכל סניף. ראשון עד חמישי 09:00-20:00.' };
  const ranked = rankWebsitePages('מה שעות הפתיחה של הסניף?', [homepage, hours], 'https://example.co.il/');
  assert.equal(ranked[0], hours);
});

test('prioritizes a contact page when the caller asks for a phone number', () => {
  const homepage = { url: 'https://example.co.il/', content: 'ברוכים הבאים. ' + 'מידע כללי '.repeat(120) };
  const contact = { url: 'https://example.co.il/contact-us', content: 'יצירת קשר. טלפון: 09-1234567. דוא"ל: service@example.co.il' };
  const ranked = rankWebsitePages('מה מספר הטלפון ליצירת קשר?', [homepage, contact], 'https://example.co.il/');
  assert.equal(ranked[0], contact);
});

test('keeps homepage first when no page has stronger relevance', () => {
  const homepage = { url: 'https://example.co.il/', content: 'מידע כללי על החברה.' };
  const other = { url: 'https://example.co.il/page-a', content: 'תוכן כללי שאינו קשור לבקשה.' };
  const ranked = rankWebsitePages('תספר לי על האתר', [homepage, other], 'https://example.co.il/');
  assert.equal(ranked[0], homepage);
});

test('handles missing pages safely', () => {
  assert.deepEqual(rankWebsitePages('שעות פתיחה', null), []);
});
