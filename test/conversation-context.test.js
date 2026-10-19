import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRelevantHistoryForTurn } from '../conversation-context.js';

const oldHistory = 'תור 1 — מתקשר: מה המחיר של מוצר א?\nתשובה: המחיר הוא מאה שקלים.';

test('a standalone new question receives no stale prior-call history', () => {
  assert.equal(selectRelevantHistoryForTurn('מה מזג האוויר היום?', oldHistory, []), '');
});

test('an explicit follow-up can use prior-call history', () => {
  assert.equal(selectRelevantHistoryForTurn('תרחיב על הפרט הראשון', oldHistory, []), oldHistory);
});

test('an explicit follow-up within a call uses current-call turns, not older calls', () => {
  const current = [{ user: 'מה המחיר של מוצר ב?', assistant: 'המחיר הוא מאתיים שקלים.' }];
  assert.match(selectRelevantHistoryForTurn('ומה לגבי האחריות שלהם?', oldHistory, current), /מוצר ב/);
  assert.doesNotMatch(selectRelevantHistoryForTurn('ומה לגבי האחריות שלהם?', oldHistory, current), /מוצר א/);
});

test('caller correction retains the immediately relevant question context', () => {\n  const current = [{ user: 'מה שעות הפתיחה של הסניף?', assistant: 'הסניף פתוח עד חמש.' }];\n  assert.match(selectRelevantHistoryForTurn('שמעת מה שאלתי אותך?', oldHistory, current), /שעות הפתיחה של הסניף/);\n});\n\ntest('a new topic does not receive current-call history just because it follows another turn', () => {
  const current = [{ user: 'מה המחיר של מוצר א?', assistant: 'מאה שקלים.' }];
  assert.equal(selectRelevantHistoryForTurn('איך עובד מנוע חשמלי?', oldHistory, current), '');
});
