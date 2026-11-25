import test from 'node:test';
import assert from 'node:assert/strict';
import { callCompatibleChatCompletion } from './provider-fallback.js';

const base = {
  provider: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'test-key',
  model: 'openai/gpt-oss-20b',
  messages: [{ role: 'user', content: 'ענה בעברית: שלום' }]
};

test('compatible provider returns answer and sends expected request', async () => {
  let request;
  const answer = await callCompatibleChatCompletion({
    ...base,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'שלום לך' } }] }) };
    }
  });
  assert.equal(answer, 'שלום לך');
  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'openai/gpt-oss-20b');
  assert.equal(request.body.stream, false);
});

test('429 response sets cooldown and prevents immediate repeated calls', async () => {
  const cooldowns = new Map();
  let calls = 0;
  const options = {
    ...base,
    cooldowns,
    now: () => 1000,
    cooldownMs: 5000,
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 429, text: async () => 'rate limited' };
    }
  };
  await assert.rejects(callCompatibleChatCompletion(options), error => error.status === 429);
  await assert.rejects(callCompatibleChatCompletion(options), error => error.status === 429 && error.coolingDown === true);
  assert.equal(calls, 1);
});

test('empty model response is treated as provider failure', async () => {
  await assert.rejects(
    callCompatibleChatCompletion({
      ...base,
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '  ' } }] }) })
    }),
    error => error.status === 502 && /empty answer/.test(error.message)
  );
});

test('missing credentials fail closed without making a request', async () => {
  let calls = 0;
  await assert.rejects(
    callCompatibleChatCompletion({ ...base, apiKey: '', fetchImpl: async () => { calls++; } }),
    error => error.status === 400
  );
  assert.equal(calls, 0);
});

test('429 honors Retry-After and never exposes provider response body', async () => {
  const cooldowns = new Map();
  let calls = 0;
  const options = {
    ...base, cooldowns, now: () => 1000, cooldownMs: 5000,
    fetchImpl: async () => {
      calls++;
      return {
        ok: false, status: 429,
        headers: { get: name => name.toLowerCase() === 'retry-after' ? '120' : null },
        text: async () => 'SECRET_PROVIDER_RESPONSE_SHOULD_NOT_APPEAR'
      };
    }
  };
  await assert.rejects(callCompatibleChatCompletion(options), error =>
    error.status === 429 &&
    !error.message.includes('SECRET_PROVIDER_RESPONSE_SHOULD_NOT_APPEAR')
  );
  await assert.rejects(callCompatibleChatCompletion(options), error =>
    error.status === 429 && error.coolingDown === true && error.retryAfterMs === 120000
  );
  assert.equal(calls, 1);
});

test('402 credit exhaustion sets a quota cooldown without exposing body', async () => {
  const cooldowns = new Map();
  await assert.rejects(callCompatibleChatCompletion({
    ...base, cooldowns, now: () => 1000,
    fetchImpl: async () => ({
      ok: false, status: 402,
      text: async () => 'sensitive account details'
    })
  }), error => error.status === 402 && error.exhausted === true && !error.message.includes('sensitive'));
  // 25.11: a provider that now needs a payment method rests for 6 hours.
  assert.equal(cooldowns.get('Groq'), 1000 + 6 * 3600_000);
});

test('a trial key that used its monthly calls rests for 6 hours, a plain 429 briefly', async () => {
  const cooldowns = new Map();
  await assert.rejects(callCompatibleChatCompletion({
    ...base, cooldowns, now: () => 1000,
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null },
      text: async () => 'You are using a Trial key, which is limited to 1000 API calls / month.' })
  }), error => error.status === 429 && error.exhausted === true && !/Trial key/.test(error.message));
  assert.equal(cooldowns.get('Groq'), 1000 + 6 * 3600_000);
  const short = new Map();
  await assert.rejects(callCompatibleChatCompletion({
    ...base, cooldowns: short, now: () => 1000,
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'Rate limit reached for tokens per minute' })
  }), error => error.status === 429 && !error.exhausted);
  assert.equal(short.get('Groq'), 91000);
});
