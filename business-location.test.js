import test from 'node:test';
import assert from 'node:assert/strict';
import { extractExplicitLocation } from './business-location.js';

test('extracts Ramot David and Kiryat Gat from common Hebrew speech spellings', () => {
  const location = extractExplicitLocation('תמצא לי חניות ברמות דוד בקירית גת');
  assert.equal(location.area, 'רמות דוד');
  assert.equal(location.city, 'קירית גת');
});
