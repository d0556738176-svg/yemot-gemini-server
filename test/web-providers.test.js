import test from 'node:test';
import assert from 'node:assert/strict';
import { searchSerper, searchLangSearch, searchJina, searchSecondary, readPage, describeImageWithCloudflare, configuredSecondarySearch } from '../web-providers.js';

const realFetch = globalThis.fetch;
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = {}, delayMs = 0 } = await handler(String(url), init);
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
function withEnv(vars, fn) {
  return async () => {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
    try { await fn(); } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

test('Serper sends the key header and puts the answer box first', withEnv({ SERPER_API_KEY: 'k1' }, async () => {
  const calls = mockFetch(() => ({ body: {
    answerBox: { answer: '*2800', title: 'מוקד', link: 'https://bank.example/contact' },
    organic: [{ title: 'בנק', link: 'https://bank.example', snippet: 'שירות לקוחות' }]
  } }));
  const results = await searchSerper('בנק טלפון');
  assert.equal(calls[0].init.headers['x-api-key'], 'k1');
  assert.equal(JSON.parse(calls[0].init.body).gl, 'il');
  assert.equal(results[0].snippet.includes('*2800'), true);
  assert.equal(results.length, 2);
}));

test('LangSearch parses webPages and prefers the summary', withEnv({ LANGSEARCH_API_KEY: 'k2' }, async () => {
  const calls = mockFetch(() => ({ body: { data: { webPages: { value: [
    { name: 'כותרת', url: 'https://a.example/x', snippet: 'קצר', summary: 'סיכום מלא' }
  ] } } } }));
  const results = await searchLangSearch('שאלה');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k2');
  assert.deepEqual(results, [{ title: 'כותרת', url: 'https://a.example/x', snippet: 'סיכום מלא' }]);
}));

test('Jina search sends the Bearer key (the old code sent none and got 401)', withEnv({ JINA_API_KEY: 'jk' }, async () => {
  const calls = mockFetch(() => ({ body: { data: [{ title: 'T', url: 'https://j.example', description: 'D' }] } }));
  const results = await searchJina('q');
  assert.equal(calls[0].init.headers.authorization, 'Bearer jk');
  assert.equal(results[0].url, 'https://j.example');
}));

test('secondary search returns the first engine with results and skips missing keys',
  withEnv({ LANGSEARCH_API_KEY: 'a', SERPER_API_KEY: 'b', JINA_API_KEY: null }, async () => {
    assert.deepEqual(configuredSecondarySearch(), ['langsearch', 'serper']);
    mockFetch(url => url.includes('langsearch')
      ? { status: 500, body: { message: 'down' } }
      : { body: { organic: [{ title: 'ok', link: 'https://ok.example', snippet: 's' }] } });
    const { provider, results } = await searchSecondary('שאלה ייחודית 1');
    assert.equal(provider, 'serper');
    assert.equal(results[0].title, 'ok');
  }));

test('page reader falls back to Firecrawl when Jina fails', withEnv({ FIRECRAWL_API_KEY: 'fc', CRAWL4AI_KEY: null, JINA_API_KEY: null }, async () => {
  const text = 'תוכן הדף '.repeat(40);
  mockFetch(url => url.startsWith('https://r.jina.ai/')
    ? { status: 451, body: { message: 'blocked' } }
    : { body: { success: true, data: { markdown: text, metadata: { title: 'דף', sourceURL: 'https://site.example/p' } } } });
  const page = await readPage('https://site.example/p', { hedgeMs: 50, timeoutMs: 3000 });
  assert.equal(page.provider, 'firecrawl');
  assert.equal(page.title, 'דף');
}));

test('Cloudflare vision discovers the account ID from the token', withEnv({ CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ACCOUNT_ID: null }, async () => {
  const calls = mockFetch(url => url.includes('/accounts?')
    ? { body: { result: [{ id: 'acc123' }] } }
    : { body: { result: { response: 'נראה עץ ירוק' } } });
  const text = await describeImageWithCloudflare(Buffer.from('img'), 'image/png', 'תאר');
  assert.equal(text, 'נראה עץ ירוק');
  assert.match(calls[1].url, /accounts\/acc123\/ai\/run\/@cf\//);
  const body = JSON.parse(calls[1].init.body);
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
}));

test('opening a named site prefers the homepage over a directory page about it', async () => {
  const { selectWebsiteResult } = await import('../website-selection.js');
  const pick = selectWebsiteResult('פתח אתר בנק הפועלים', [
    { title: 'בנק הפועלים - שירות לקוחות | השג לי נציג', url: 'https://directory.example/companies/bank-hapoalim/service' },
    { title: 'בנק הפועלים - דף הבית', url: 'https://www.bankhapoalim.co.il/' }
  ]);
  assert.equal(pick.url, 'https://www.bankhapoalim.co.il/');
});

test('official site comes from the Google knowledge panel', withEnv({ SERPER_API_KEY: 'k' }, async () => {
  const { findOfficialWebsite } = await import('../web-providers.js');
  mockFetch(() => ({ body: { knowledgeGraph: { title: 'בנק הפועלים', website: 'https://www.bankhapoalim.co.il/' }, organic: [] } }));
  const found = await findOfficialWebsite('בנק הפועלים');
  assert.equal(found.url, 'https://www.bankhapoalim.co.il/');
}));

test('follow-ups about the found video stay on YouTube', async () => {
  const { mayUseYouTubeSearch } = await import('../branch1-turn-context.js');
  const ctx = { lastRoute: 'youtube' };
  assert.equal(mayUseYouTubeSearch('מה בדיוק הוא אמר בסרטון הזה, שלב אחרי שלב', ctx), true);
  assert.equal(mayUseYouTubeSearch('תמחיש לי מה רואים בסרטון', ctx), true);
  assert.equal(mayUseYouTubeSearch('מה בדיוק הוא אמר', { lastRoute: 'other' }), false);
});

test('official site falls back to the result Google shows with sitelinks', withEnv({ SERPER_API_KEY: 'k' }, async () => {
  const { findOfficialWebsite } = await import('../web-providers.js');
  mockFetch(() => ({ body: { organic: [
    { title: 'בנק הפועלים - שירות לקוחות', link: 'https://sherutplus.com/bank-hapoalim' },
    { title: 'בנק הפועלים', link: 'https://www.bankhapoalim.co.il/he', sitelinks: [{ title: 'א' }, { title: 'ב' }] }
  ] } }));
  const found = await findOfficialWebsite('בנק הפועלים');
  assert.equal(new URL(found.url).hostname, 'www.bankhapoalim.co.il');
  assert.equal(found.source, 'sitelinks');
}));

test('website text read aloud drops image and link paths', async () => {
  const { speakablePageText } = await import('../branch1-websites.js');
  const raw = 'בנק הפועלים (/api/media/l3h/logo.svg) סניפים ! (/ next/image?url=%2Fapi w=96) צרו קשר ![x](https://a.b/c.png) [אודות](/about)';
  const out = speakablePageText(raw);
  assert.equal(/api|next|\.svg|png|!/.test(out), false);
  assert.match(out, /בנק הפועלים סניפים צרו קשר אודות/);
});

test('an open page keeps link questions even after other turns', async () => {
  const { isBranch1WebsiteRequest } = await import('../branch1-websites.js');
  const ctx = { currentWebsitePages: [{ url: 'https://www.bankhapoalim.co.il/', content: 'x', links: [] }], lastRoute: 'other' };
  assert.equal(isBranch1WebsiteRequest('איזה קישורים יש בעמוד', ctx), true);
  assert.equal(isBranch1WebsiteRequest('איזה כישורים יש בעמוד', ctx), true);
  assert.equal(isBranch1WebsiteRequest('פתח קישור מספר 3', ctx), true);
  assert.equal(isBranch1WebsiteRequest('מה מזג האוויר מחר', ctx), false);
});

test('an answer to a clarifying question completes the earlier question', async () => {
  const { resolveClarificationAnswer } = await import('../conversation-context.js');
  const history = [{ user: 'האם רמי לוי פתוח עכשיו?', assistant: 'באיזו עיר או באיזה אזור נמצא הסניף? כך אוכל לבדוק את שעות הפתיחה' }];
  assert.equal(resolveClarificationAnswer('בבית שמש בקניון השדרה', history), 'האם רמי לוי פתוח עכשיו בבית שמש בקניון השדרה');
  assert.equal(resolveClarificationAnswer('מה מזג האוויר מחר', history), '');
  assert.equal(resolveClarificationAnswer('בבית שמש', [{ user: 'שלום', assistant: 'היי, מה שלומך היום.' }]), '');
});
