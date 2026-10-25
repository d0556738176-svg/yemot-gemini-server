import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldForceWebSearch } from '../branch1-web-router.js';

test('routes external factual business questions to live web retrieval', () => {
  assert.equal(shouldForceWebSearch('מה שעות הפתיחה של סופר פארם בקניון עזריאלי תל אביב לכל יום בשבוע'), true);
  assert.equal(shouldForceWebSearch('מה מספר הטלפון של בנק דיסקונט'), true);
  assert.equal(shouldForceWebSearch('איזה שירותים יש בסניף הזה'), true);
});

test('keeps ordinary timeless conversation off the web path', () => {
  assert.equal(shouldForceWebSearch('תסביר לי בקצרה איך עובד מנוע חשמלי'), false);
  assert.equal(shouldForceWebSearch('תן לי שלושה יתרונות מרכזיים בקצרה'), false);
});
