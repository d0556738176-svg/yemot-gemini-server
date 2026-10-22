import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRelevantHistoryForTurn, resolvePendingLookupQuestion } from './conversation-context.js';

const lookup = q => /דיסקונט|סופר.?פארם|חנויות|שעות פתיחה|מספר טלפון/i.test(q);

test('short status follow-up reruns previous unanswered lookup', () => {
  const history = [
    { user: 'מה המספר של דיסקונט?', assistant: 'אני מיד בודק מה מספר הטלפון של דיסקונט ומביא לך אותו.' }
  ];
  assert.equal(resolvePendingLookupQuestion('נו, מצאת?', history, lookup), 'מה המספר של דיסקונט?');
});

test('follow-up keeps context from the current call', () => {
  const history = [
    { user: 'מה המספר של דיסקונט?', assistant: 'אני בודק.' },
    { user: 'נו, מצאת?', assistant: 'לא מצאתי עדיין.' }
  ];
  const text = selectRelevantHistoryForTurn('תמשיך', '', history);
  assert.match(text, /מה המספר של דיסקונט/);
  assert.match(text, /נו, מצאת/);
});

test('does not attach an unrelated new question to an old lookup', () => {
  const history = [{ user: 'מה המספר של דיסקונט?', assistant: 'אני בודק.' }];
  assert.equal(resolvePendingLookupQuestion('מה מזג האוויר מחר?', history, lookup), '');
});


test('ordinary new turn still receives durable caller memory', () => {
  const persisted = 'תור 1 — מתקשר: אני מעדיף תשובות קצרות\nתשובה: בסדר';
  const text = selectRelevantHistoryForTurn('תן לי רעיון חדש', persisted, []);
  assert.match(text, /אני מעדיף תשובות קצרות/);
});

test('durable memory and current-call turns are both retained for follow-up', () => {
  const persisted = 'תור 1 — מתקשר: דיברנו על פרויקט אלפא\nתשובה: נכון';
  const current = [{ user: 'עכשיו תבדוק את התקציב', assistant: 'בסדר' }];
  const text = selectRelevantHistoryForTurn('תמשיך', persisted, current);
  assert.match(text, /פרויקט אלפא/);
  assert.match(text, /התקציב/);
});
