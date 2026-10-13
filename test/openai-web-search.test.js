import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerWithOpenAIText,
  answerWithOpenAIWebSearch,
  buildOpenAIWebSearchPayload,
  extractOpenAIResponseText,
  isOpenAIWebSearchRequest,
  stripOpenAIWebSearchPrefix
} from '../openai-web-search.js';

test('recognizes explicit Hebrew ChatGPT web-search commands', () => {
  assert.equal(isOpenAIWebSearchRequest('חפש ב-ChatGPT מה החדשות היום'), true);
  assert.equal(isOpenAIWebSearchRequest('תחפש לי ב ChatGPT שעות פתיחה'), true);
  assert.equal(isOpenAIWebSearchRequest('תעשה חיפוש דרך ChatGPT על מוצר מסוים'), true);
  assert.equal(isOpenAIWebSearchRequest('מה זה ChatGPT'), false);
  assert.equal(isOpenAIWebSearchRequest('חפש באינטרנט מה החדשות'), false);
});

test('removes the spoken provider prefix without losing the search query', () => {
  assert.equal(stripOpenAIWebSearchPrefix('חפש ב-ChatGPT: מה החדשות היום'), 'מה החדשות היום');
  assert.equal(stripOpenAIWebSearchPrefix('תחפש לי ב ChatGPT שעות פתיחה'), 'שעות פתיחה');
});

test('builds a Responses API request that requires live web search', () => {
  const payload = buildOpenAIWebSearchPayload('מה החדשות היום', 'נושא קודם', { date: 'יום בדיקה' });
  assert.equal(payload.model, 'gpt-5.5');
  assert.equal(payload.tool_choice, 'required');
  assert.equal(payload.tools[0].type, 'web_search');
  assert.equal(payload.input.includes('יום בדיקה'), true);
  assert.equal(payload.input.includes('נושא קודם'), true);
});

test('extracts text from Responses API output', () => {
  assert.equal(extractOpenAIResponseText({ output_text: '  תשובה מוכנה  ' }), 'תשובה מוכנה');
  assert.equal(extractOpenAIResponseText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'תשובה מהפלט' }] }] }), 'תשובה מהפלט');
});

test('uses the configured key and returns a successful response', async () => {
  let captured = null;
  const answer = await answerWithOpenAIWebSearch('בדיקה', '', {
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ output_text: 'תוצאה מאומתת' }) };
    }
  });
  assert.equal(answer, 'תוצאה מאומתת');
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-key');
  assert.equal(captured.body.tool_choice, 'required');
});

test('reports missing key without sending a request', async () => {
  await assert.rejects(
    answerWithOpenAIWebSearch('בדיקה', '', { apiKey: '', fetchImpl: async () => { throw new Error('must not call'); } }),
    /OPENAI_API_KEY is not configured/
  );
});


test('answers ordinary phone prompts through the OpenAI Responses API without forcing web search', async () => {
  let captured = null;
  const answer = await answerWithOpenAIText('ענה ב-JSON בלבד: {"answer":"שלום"}', {
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ output_text: '{"answer":"שלום"}' }) };
    }
  });
  assert.equal(answer, '{"answer":"שלום"}');
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-key');
  assert.equal(captured.body.tools, undefined);
});

test('enables required live web search only when the branch 1 fallback requests it', async () => {
  let payload = null;
  await answerWithOpenAIText('חפש באינטרנט מידע עדכני', {
    apiKey: 'test-key',
    webSearch: true,
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ output_text: 'תשובה לאחר חיפוש' }) };
    }
  });
  assert.equal(payload.tool_choice, 'required');
  assert.equal(payload.tools[0].type, 'web_search');
});

test('ordinary OpenAI fallback refuses to call the API without a key', async () => {
  await assert.rejects(
    answerWithOpenAIText('בדיקה', { apiKey: '', fetchImpl: async () => { throw new Error('must not call'); } }),
    /OPENAI_API_KEY is not configured/
  );
});
