import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHebrewPhoneTranscript } from '../transcript-normalization.js';

test('normalizes common Super-Pharm speech recognition variants', () => {
  assert.equal(
    normalizeHebrewPhoneTranscript('מה השעות של סופר פרם בקניון עזריאלי'),
    'מה השעות של סופר-פארם בקניון עזריאלי'
  );
});

test('normalizes common YouTube speech variants without changing the request', () => {
  assert.equal(
    normalizeHebrewPhoneTranscript('תחפש לי בביויוטב שיר'),
    'תחפש לי ביוטיוב שיר'
  );
});

test('normalizes a known bank-name ASR confusion only in business-name context', () => {
  assert.equal(normalizeHebrewPhoneTranscript('טלפון של בנק דיווחון'), 'טלפון של בנק דיסקונט');
  assert.equal(normalizeHebrewPhoneTranscript('הוא דיווחון את זה'), 'הוא דיווחון את זה');
});

test('preserves ordinary words and cleans spacing/control marks', () => {
  assert.equal(normalizeHebrewPhoneTranscript('  תבדוק  לי\u200f עכשיו  '), 'תבדוק לי עכשיו');
});
