import test from 'node:test';
import assert from 'node:assert/strict';
import { isMultimodalAnalysisRequest, isVisualContinuationRequest } from '../visual-intent.js';

test('ordinary explanation request does not enter visual analysis', () => {
  assert.equal(isMultimodalAnalysisRequest('תוכל להסביר לי איך זה עובד?').any, false);
});

test('ambiguous show and illustrate verbs alone do not enter visual analysis', () => {
  assert.equal(isMultimodalAnalysisRequest('תראה לי איך להגדיר את Render').any, false);
  assert.equal(isMultimodalAnalysisRequest('תמחיש לי את ההבדל בין שתי אפשרויות').any, false);
});

test('explicit image request is routed to image analysis', () => {
  assert.equal(isMultimodalAnalysisRequest('תמצא לי תמונה של אייל גולן').image, true);
  assert.equal(isMultimodalAnalysisRequest('מה רואים בתמונה הזאת?').image, true);
});

test('explicit video analysis is routed to video analysis', () => {
  assert.equal(isMultimodalAnalysisRequest('תנתח את הסרטון הזה').video, true);
});

test('negative image request does not trigger image analysis', () => {
  assert.equal(isMultimodalAnalysisRequest('אני לא רוצה תמונה, רק הסבר מילולי').any, false);
});

test('generic retry does not inherit an old visual topic when the immediately prior turn was ordinary', () => {
  const history = 'תור 1 — מתקשר: תמצא לי תמונה של זמר\nתשובה: הנה תיאור התמונה.\n\nתור 2 — מתקשר: מה השעה?\nתשובה: השעה שלוש.';
  assert.equal(isVisualContinuationRequest('תנסה שוב', history), false);
});

test('generic retry may continue a visual request from the immediately prior turn', () => {
  const history = 'תור 1 — מתקשר: תמצא לי תמונה של זמר\nתשובה: לא מצאתי תמונה זמינה.';
  assert.equal(isVisualContinuationRequest('תנסה שוב', history), true);
});

test('generic retry without a visual prior turn does not trigger image analysis', () => {
  const history = 'תור 1 — מתקשר: מה השעה?\nתשובה: השעה שלוש.';
  assert.equal(isVisualContinuationRequest('תנסה שוב', history), false);
});
