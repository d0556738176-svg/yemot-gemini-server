import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isYouTubeConfirmationYes,
  isYouTubeConfirmationNo
} from './youtube-confirmation.js';

test('recognizes short and natural affirmative Hebrew answers', () => {
  for (const answer of [
    'כן', 'כן.', 'כן בהחלט', 'בוודאי', 'בטח', 'ברור',
    'כן אני רוצה', 'כן, תשמיע לי את השיר',
    'כן תשמיע לי את הסרטון',
    'כן, אני רוצה לשמוע את זה',
    'כן אני רוצה לשמוע את הסרטון',
    'אני רוצה לשמוע את זה',
    'רוצה לשמוע את הסרטון',
    'תשמיע לי את זה',
    'תפעיל את הסרטון'
  ]) {
    assert.equal(isYouTubeConfirmationYes(answer), true, answer);
  }
});

test('recognizes negative Hebrew answers', () => {
  for (const answer of [
    'לא', 'לא תודה', 'לא רוצה', 'סיימתי', 'זה מספיק',
    'לא, חיפוש חדש', 'אני לא רוצה לשמוע את זה'
  ]) {
    assert.equal(isYouTubeConfirmationNo(answer), true, answer);
  }
});

test('does not confuse negatives, ambiguity, or new-search requests with playback approval', () => {
  for (const answer of [
    'לא', 'לא תודה', 'אני לא רוצה לשמוע את זה',
    'לא, בעצם כן', 'כן, חיפוש חדש', 'כן, חפש משהו אחר',
    'כן, משהו אחר', ''
  ]) {
    assert.equal(isYouTubeConfirmationYes(answer), false, answer);
  }
  assert.equal(isYouTubeConfirmationNo('כן'), false);
  assert.equal(isYouTubeConfirmationNo('כן, חיפוש חדש'), false);
  assert.equal(isYouTubeConfirmationNo('לא, בעצם כן'), false);
});
