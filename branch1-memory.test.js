import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberTurn, readMemory, memoryPath, KEEP_TURNS } from './branch1-memory.js';
import { selectRelevantHistoryForTurn } from './conversation-context.js';

function fakeYemot() {
  const files = new Map();
  return { files, fetchImpl: async (url, init = {}) => {
    const u = new URL(url);
    const path = u.searchParams.get('path');
    if (u.pathname.endsWith('/DownloadFile')) return files.has(path) ? new Response(files.get(path)) : new Response('', { status: 404 });
    if (u.pathname.endsWith('/UploadFile')) { files.set(path, await init.body.get('file').text()); return Response.json({ responseStatus: 'OK' }); }
    return new Response('', { status: 500 });
  } };
}
const env = { YEMOT_API_USERNAME: 'u', YEMOT_API_PASSWORD: 'p' };

test('a caller\'s turns survive in Yemot storage and come back on the next call', async () => {
  const y = fakeYemot();
  await rememberTurn('0501234567', { time: 't1', callId: 'a', user: 'קוראים לי דוד', gemini: 'נעים מאוד דוד' }, { env, fetchImpl: y.fetchImpl });
  await rememberTurn('0501234567', { time: 't2', callId: 'a', user: 'מה מזג האוויר', gemini: 'חם' }, { env, fetchImpl: y.fetchImpl });
  const mem = await readMemory('0501234567', { env, fetchImpl: y.fetchImpl });
  assert.equal(mem.entries.length, 2);
  assert.equal(mem.entries[0].user, 'קוראים לי דוד');
  assert.equal(memoryPath('0501234567'), 'ivr2:/ai_memory/0501234567.json');
});
test('old turns are folded into a summary, recent ones kept word for word', async () => {
  const y = fakeYemot();
  for (let i = 0; i < 81; i++) await rememberTurn('0509999999', { time: 't' + i, user: 'שאלה ' + i, gemini: 'תשובה' }, { env, fetchImpl: y.fetchImpl });
  const mem = await readMemory('0509999999', { env, fetchImpl: y.fetchImpl });
  assert.equal(mem.entries.length, KEEP_TURNS);
  assert.match(mem.summary, /שאלה 0/);
});
test('questions about earlier calls receive the saved memory', () => {
  for (const q of ['על מה דיברנו בפעם הקודמת?', 'אתה זוכר מה שאלתי אותך אתמול?', 'מה השם שלי?'])
    assert.match(selectRelevantHistoryForTurn(q, 'תור 1 — מתקשר: קוראים לי דוד', []), /דוד/);
  assert.equal(selectRelevantHistoryForTurn('מה השעה בניו יורק', 'תור 1 — מתקשר: קוראים לי דוד', []), '');
});

test('a temporary memory read error never overwrites the saved conversation', async () => {
  const y = fakeYemot();
  const phone = '0501112233';
  const previous = { time: 't1', callId: 'a', user: 'שאלה ראשונה', gemini: 'תשובה ראשונה' };
  const next = { time: 't2', callId: 'b', user: 'שאלה שנייה', gemini: 'תשובה שנייה' };
  const opts = { env, fetchImpl: y.fetchImpl };
  await rememberTurn(phone, previous, opts);
  await assert.rejects(rememberTurn(phone, next, {
    env, fetchImpl: async (url, init) => init.method === 'POST' ? y.fetchImpl(url, init) : new Response('', { status: 503 })
  }), /HTTP 503/);
  assert.deepEqual((await readMemory(phone, opts)).entries, [previous]);
  await rememberTurn(phone, next, opts);
  assert.deepEqual((await readMemory(phone, opts)).entries, [previous, next]);
});
