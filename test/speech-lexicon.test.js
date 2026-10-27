import test from 'node:test';
import assert from 'node:assert/strict';
import {fuzzyCorrectEntities} from '../speech-lexicon.js';

test('sound-alike mistakes are corrected generically',()=>{
  assert.equal(fuzzyCorrectEntities('מה המספר של סוף אברהם ברעננה'),'מה המספר של סופר פארם ברעננה');
  assert.equal(fuzzyCorrectEntities('מה המספר של יוסף אפרים ברעננה'),'מה המספר של סופר פארם ברעננה');
  assert.equal(fuzzyCorrectEntities('מה המספר של בנק דישקונט'),'מה המספר של בנק דיסקונט');
  assert.equal(fuzzyCorrectEntities('מה המספר של שופר סל בכפר סבה'),'מה המספר של שופרסל בכפר סבא');
});

test('pharmacy mis-hearing is corrected',()=>{
  assert.equal(fuzzyCorrectEntities('איפה יש בית מקחת פתוח ברעננה'),'איפה יש בית מרקחת פתוח ברעננה');
});

test('correct text and ordinary sentences are left unchanged',()=>{
  for(const t of ['מה המספר של סופר פארם ברעננה','מה החדשות היום בישראל','מה מזג האוויר מחר','סוף השבוע בירושלים','מה זה אנרגיה סולרית','תמשיך לדבר בבקשה'])
    assert.equal(fuzzyCorrectEntities(t),t);
});
