import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isYouTubeConfirmationYes,
  isYouTubeConfirmationNo
} from './youtube-confirmation.js';

test('recognizes common affirmative Hebrew answers', () => {
  for (const answer of [
    'כן', 'כן.', 'כן בהחלט', 'בוודאי', 'בטח', 'ברור',
    'כן אני רוצה', 'כן, תשמיע לי את השיר', 'כן תשמיע לי את הסרטון'
  ]) {
    assert.equal(isYouTubeConfirmationYes(answer), true, answer);
  }
});

test('recognizes common negative Hebrew answers', () => {
  for (const answer of ['לא', 'לא תודה', 'לא רוצה', 'סיימתי', 'זה מספיק', 'לא, חיפוש חדש']) {
    assert.equal(isYouTubeConfirmationNo(answer), true, answer);
  }
});

test('does not confuse negative or ambiguous answers with approval', () => {
  for (const answer of ['לא', 'לא תודה', 'לא, בעצם כן', 'כן, חיפוש חדש', 'כן, משהו אחר', '']) {
    assert.equal(isYouTubeConfirmationYes(answer), false, answer);
  }
  assert.equal(isYouTubeConfirmationNo('כן'), false);
  assert.equal(isYouTubeConfirmationNo('לא, בעצם כן'), false);
});
