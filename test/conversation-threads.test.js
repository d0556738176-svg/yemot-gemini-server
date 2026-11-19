import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.CONVERSATION_DIR = mkdtempSync(join(tmpdir(), 'threads-'));
const T = await import('../conversation-threads.js');

test('a conversation goes on across calls, and each extension has its own', async () => {
  T.clearThreadCache();
  await T.currentThread('3', '0501', { legacy: [] });
  await T.appendTurn('3', '0501', { callId: 'c1', user: 'מה זה פוטוסינתזה', gemini: 'תהליך בצמחים' });
  await T.appendTurn('3', '0501', { callId: 'c2', user: 'ומה עם אור', gemini: 'אור הוא אנרגיה' });
  await T.appendTurn('1', '0501', { callId: 'c3', user: 'מה מזג האוויר', gemini: 'חם' });
  T.clearThreadCache(); // as after a restart: read back from disk
  const th = await T.currentThread('3', '0501');
  assert.equal(th.turns.length, 2);
  assert.equal(th.title, 'מה זה פוטוסינתזה');
  const ctx = T.threadContext(th, 'c2');
  assert.deepEqual(ctx.prior.map(t => t.user), ['מה זה פוטוסינתזה']);
  assert.equal((await T.currentThread('1', '0501')).turns.length, 1);
});
test('a new conversation starts empty; the history lists both, newest first, and goes back', async () => {
  const fresh = await T.newThread('3', '0501');
  assert.equal(fresh.turns.length, 0);
  assert.equal((await T.newThread('3', '0501')).id, fresh.id, 'an empty one is reused');
  await T.appendTurn('3', '0501', { callId: 'c4', user: 'תספרי לי על ירושלים', gemini: 'עיר עתיקה' });
  const list = await T.listThreads('3', '0501');
  assert.equal(list.length, 2);
  assert.equal(list[0].title, 'תספרי לי על ירושלים');
  assert.equal(list[0].current, true);
  await T.selectThread('3', '0501', list[1].id);
  assert.equal((await T.currentThread('3', '0501')).title, 'מה זה פוטוסינתזה');
});
test('no limit: hundreds of turns are all kept; the model gets the last ones and the older topics', async () => {
  await T.newThread('3', '0777');
  for (let i = 0; i < 300; i++) await T.appendTurn('3', '0777', { callId: 'k' + i, user: 'שאלה מספר ' + i, gemini: 'תשובה' });
  T.clearThreadCache();
  const th = await T.currentThread('3', '0777');
  assert.equal(th.turns.length, 300);
  const ctx = T.threadContext(th, 'now');
  assert.equal(ctx.prior.length, 16);
  assert.match(ctx.topics, /שאלה מספר 283/);
});
test('the old saved turns become the first conversation', async () => {
  const th = await T.currentThread('1', '0999', { legacy: [{ time: '2026-11-17T10:00:00Z', callId: 'old', user: 'שאלה ישנה', gemini: 'תשובה ישנה' }] });
  assert.equal(th.title, 'השיחות הקודמות');
  assert.equal(th.turns.length, 1);
});
