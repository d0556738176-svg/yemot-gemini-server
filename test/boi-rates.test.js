import test from 'node:test';
import assert from 'node:assert/strict';
import { rateAnswer } from '../boi-rates.js';
test('the dollar and the euro from the Bank of Israel', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ exchangeRates: [{ key: 'USD', currentExchangeRate: 3.324, currentChange: -0.12, unit: 1, lastUpdate: '2026-11-27T13:20:00Z' }, { key: 'EUR', currentExchangeRate: 3.86, currentChange: 0.2, unit: 1, lastUpdate: '2026-11-27T13:20:00Z' }] }) });
  const a = await rateAnswer('כמה עולה דולר היום ויורו', { fetchImpl, log: {} });
  assert.match(a, /הדולר הוא 3 נקודה 324 שקלים/); assert.match(a, /היורו הוא 3 נקודה 86/); assert.match(a, /ירידה/);
  assert.equal(await rateAnswer('תסביר לי מה זה אינפלציה', { fetchImpl, log: {} }), '');
});
