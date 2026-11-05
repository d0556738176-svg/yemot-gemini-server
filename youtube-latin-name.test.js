import test from 'node:test';
import assert from 'node:assert/strict';
import { latinTitle, latinFileName, hebrewToLatin } from './youtube-latin-name.js';
test('file names carry no Hebrew letters (Yemot blanks them on download)', async () => {
  const name = latinFileName(await latinTitle('מוטי שטיינמץ - הנשמה בקרבי', {}));
  assert.match(name, /^[A-Za-z0-9_]+$/);
  assert.ok(name.length > 5);
  assert.equal(latinFileName('SHWEKEY - Your Time'), 'SHWEKEY_Your_Time');
});
test('language model spelling is used when available', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Haneshama Bekirbi' } }] }) });
  assert.equal(await latinTitle('הנשמה בקרבי', { GROQ_API_KEY: 'k' }, fetchImpl), 'Haneshama Bekirbi');
  const bad = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'הנשמה' } }] }) });
  assert.equal(await latinTitle('הנשמה', { GROQ_API_KEY: 'k' }, bad), hebrewToLatin('הנשמה'));
});
