import test from 'node:test';
import assert from 'node:assert/strict';
import { isWebSearchIntent } from './web-search-intent.js';

test('forces live search for explicit source and citation requests', () => {
  for (const q of [
    'ציין לי מאילו מקורות המידע הגיע',
    'השווה בין כמה מקורות אמינים',
    'תביא מקורות רשמיים',
    'מה מקור המידע הזה?',
    'תן תשובה עם סימוכין',
    'ציין מקורות וציטוטים'
  ]) assert.equal(isWebSearchIntent(q), true, q);
});

test('keeps existing explicit web-search commands working', () => {
  for (const q of [
    'חפש באינטרנט מידע על אנרגיה סולארית',
    'תפתח את האתר הרשמי',
    'מה כתוב בעמוד הזה?',
    'מה מספר הטלפון של הסניף?'
  ]) assert.equal(isWebSearchIntent(q), true, q);
});

test('does not force search for ordinary conversational questions', () => {
  for (const q of [
    'תסביר לי מה זה אנרגיה',
    'מה דעתך על הרעיון שלי?',
    'תעזור לי לנסח הודעה קצרה'
  ]) assert.equal(isWebSearchIntent(q), false, q);
});

test('handles empty and non-string input safely', () => {
  assert.equal(isWebSearchIntent(''), false);
  assert.equal(isWebSearchIntent(null), false);
  assert.equal(isWebSearchIntent(undefined), false);
});
