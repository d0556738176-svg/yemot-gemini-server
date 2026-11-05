// Keyed web providers for branch 1: search, page reading and image understanding.
// Every provider reads its key from the environment, sends it in the documented
// header, and is skipped when the key is missing. Keys are never logged.
import { tavily } from '@tavily/core';
import { createCooldownRegistry } from './provider-cooldowns.js';

const env = name => String(process.env[name] || '').trim();
const cooldowns = createCooldownRegistry({ quotaMs: 10 * 60 * 1000, transientMs: 30000 });

// Statuses that mean "this key cannot be used right now" (Tavily uses 432/433
// for plan and pay-as-you-go limits). They put the key aside and move on.
const KEY_EXHAUSTED = new Set([401, 403, 429, 432, 433]);

function statusOf(err) {
  return Number(err?.status || err?.response?.status || err?.statusCode ||
    (String(err?.message || '').match(/\b(4\d\d|5\d\d)\b/) || [])[1] || 0);
}

function coolKey(id, status) {
  // Exhausted or rejected keys rest longer than a transient failure.
  if (KEY_EXHAUSTED.has(status)) return cooldowns.cool(id, 429);
  return cooldowns.cool(id, status || 503);
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 4000, label = 'provider' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || data?.detail || data?.error || ('HTTP ' + response.status);
      throw Object.assign(new Error(label + ' HTTP ' + response.status + ': ' + String(message).slice(0, 160)), { status: response.status });
    }
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') throw Object.assign(new Error(label + ' timed out after ' + timeoutMs + 'ms'), { status: 408 });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
function normalizeResults(items, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const title = clean(item.title);
    const url = clean(item.url);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const key = url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url, snippet: String(item.snippet || '').trim().slice(0, 3000) });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- Tavily (primary key, then backup key) ----------

export function tavilyKeys() {
  return [...new Set([env('TAVILY_API_KEY'), env('TAVILY_BACKUP_API_KEY')].filter(Boolean))];
}

/**
 * Runs a Tavily SDK call with the primary key, then the backup key when the
 * first is out of credits, rejected or failing. With no keys configured it
 * uses Tavily's shared keyless mode (rate limited) as before.
 */
export async function withTavily(label, run) {
  const keys = tavilyKeys();
  if (!keys.length) return { result: await run(tavily()), mode: 'keyless' };
  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    const id = 'tavily:' + i;
    if (cooldowns.isCoolingDown(id) && i < keys.length - 1) continue;
    try {
      const result = await run(tavily({ apiKey: keys[i] }));
      cooldowns.clear(id);
      return { result, mode: i === 0 ? 'primary' : 'backup' };
    } catch (err) {
      lastError = err;
      const status = statusOf(err);
      coolKey(id, status);
      console.warn('[WEB_PROVIDERS] Tavily key failed', { label, key: i === 0 ? 'primary' : 'backup', status, message: String(err?.message || err).slice(0, 160) });
      // A timeout is not the key's fault; the backup key would only time out too.
      if (status === 408) break;
    }
  }
  throw lastError || Object.assign(new Error('Tavily unavailable'), { status: 503 });
}

/**
 * A single Tavily client for multi-step flows (crawl + search + extract on one
 * site) that cannot be retried as one unit: picks the first key not resting.
 */
export function tavilyClient() {
  const keys = tavilyKeys();
  if (!keys.length) return tavily();
  const index = keys.findIndex((_, i) => !cooldowns.isCoolingDown('tavily:' + i));
  return tavily({ apiKey: keys[index < 0 ? 0 : index] });
}

// ---------- Secondary search providers ----------

export async function searchLangSearch(query, { timeoutMs = 3500, count = 6 } = {}) {
  const key = env('LANGSEARCH_API_KEY');
  if (!key) throw Object.assign(new Error('LangSearch key not configured'), { status: 412 });
  const data = await fetchJson('https://api.langsearch.com/v1/web-search', {
    method: 'POST', timeoutMs, label: 'LangSearch',
    headers: { authorization: 'Bearer ' + key },
    body: { query: String(query).slice(0, 400), freshness: 'noLimit', summary: true, count }
  });
  const items = data?.data?.webPages?.value || data?.webPages?.value || [];
  return normalizeResults(items.map(x => ({ title: x.name, url: x.url, snippet: x.summary || x.snippet })), count);
}

export async function searchSerper(query, { timeoutMs = 3500, count = 8 } = {}) {
  const key = env('SERPER_API_KEY');
  if (!key) throw Object.assign(new Error('Serper key not configured'), { status: 412 });
  const data = await fetchJson('https://google.serper.dev/search', {
    method: 'POST', timeoutMs, label: 'Serper',
    headers: { 'x-api-key': key },
    body: { q: String(query).slice(0, 400), gl: 'il', hl: 'iw', num: count }
  });
  const items = [];
  // Google's answer box and knowledge panel often hold the exact phone number,
  // address or hours a caller asked for, so they go first.
  const box = data?.answerBox;
  if (box && (box.answer || box.snippet) && (box.link || data?.organic?.[0]?.link)) {
    items.push({ title: box.title || 'Google', url: box.link || data.organic[0].link, snippet: [box.answer, box.snippet].filter(Boolean).join('. ') });
  }
  const kg = data?.knowledgeGraph;
  if (kg?.title && (kg.website || kg.descriptionLink)) {
    const attrs = Object.entries(kg.attributes || {}).map(([k, v]) => k + ': ' + v).join('. ');
    items.push({ title: kg.title, url: kg.website || kg.descriptionLink, snippet: [kg.description, attrs].filter(Boolean).join('. ') });
  }
  for (const x of data?.organic || []) {
    const attrs = Object.entries(x.attributes || {}).map(([k, v]) => k + ': ' + v).join('. ');
    items.push({ title: x.title, url: x.link, snippet: [x.snippet, attrs].filter(Boolean).join('. ') });
  }
  return normalizeResults(items, count);
}

export async function searchJina(query, { timeoutMs = 4500, count = 6 } = {}) {
  const key = env('JINA_API_KEY');
  if (!key) throw Object.assign(new Error('Jina key not configured'), { status: 412 });
  const data = await fetchJson('https://s.jina.ai/?q=' + encodeURIComponent(String(query).slice(0, 300)), {
    timeoutMs, label: 'Jina search',
    // Without the Bearer header s.jina.ai answers 401 even when a key exists.
    headers: { authorization: 'Bearer ' + key, 'x-respond-with': 'no-content', 'x-locale': 'he-IL' }
  });
  const items = Array.isArray(data?.data) ? data.data : [];
  return normalizeResults(items.map(x => ({ title: x.title, url: x.url, snippet: x.description || x.content })), count);
}

const SECONDARY_SEARCH = [
  ['langsearch', 'LANGSEARCH_API_KEY', searchLangSearch],
  ['serper', 'SERPER_API_KEY', searchSerper],
  ['jina', 'JINA_API_KEY', searchJina]
];

export function configuredSecondarySearch() {
  return SECONDARY_SEARCH.filter(([, keyName]) => env(keyName)).map(([name]) => name);
}

/**
 * Races the keyed secondary search providers and returns the first non-empty
 * result set. Providers in cooldown are skipped.
 */
export async function searchSecondary(query, { timeoutMs = 3500 } = {}) {
  const racers = [];
  for (const [name, keyName, run] of SECONDARY_SEARCH) {
    if (!env(keyName)) continue;
    const id = 'search:' + name;
    if (cooldowns.isCoolingDown(id)) continue;
    racers.push(run(query, { timeoutMs }).then(results => {
      if (!results.length) throw Object.assign(new Error(name + ' returned no results'), { status: 502 });
      cooldowns.clear(id);
      console.info('[WEB_PROVIDERS] search provider succeeded', { provider: name, results: results.length });
      return { provider: name, results };
    }).catch(err => {
      const status = statusOf(err);
      if (status !== 502) coolKey(id, status);
      console.warn('[WEB_PROVIDERS] search provider failed', { provider: name, status, message: String(err?.message || err).slice(0, 160) });
      throw err;
    }));
  }
  if (!racers.length) throw Object.assign(new Error('No secondary search provider available'), { status: 503 });
  try {
    return await Promise.any(racers);
  } catch {
    throw Object.assign(new Error('All secondary search providers failed'), { status: 503 });
  }
}

// ---------- Page reading ----------

export async function readWithJina(url, { timeoutMs = 6000 } = {}) {
  const key = env('JINA_API_KEY');
  const data = await fetchJson('https://r.jina.ai/' + url, {
    timeoutMs, label: 'Jina reader',
    headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), 'x-return-format': 'markdown', 'x-retain-images': 'none' }
  });
  return { title: clean(data?.data?.title), url: data?.data?.url || url, content: String(data?.data?.content || '').trim() };
}

export async function readWithFirecrawl(url, { timeoutMs = 9000 } = {}) {
  const key = env('FIRECRAWL_API_KEY');
  if (!key) throw Object.assign(new Error('Firecrawl key not configured'), { status: 412 });
  const data = await fetchJson('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST', timeoutMs, label: 'Firecrawl',
    headers: { authorization: 'Bearer ' + key },
    body: { url, formats: ['markdown'], onlyMainContent: true, timeout: Math.max(3000, timeoutMs - 500) }
  });
  return { title: clean(data?.data?.metadata?.title), url: data?.data?.metadata?.sourceURL || url, content: String(data?.data?.markdown || '').trim() };
}

export async function readWithCrawl4ai(url, { timeoutMs = 9000 } = {}) {
  const key = env('CRAWL4AI_KEY');
  if (!key) throw Object.assign(new Error('Crawl4AI key not configured'), { status: 412 });
  const data = await fetchJson('https://api.crawl4ai.com/scrape', {
    method: 'POST', timeoutMs, label: 'Crawl4AI',
    headers: { authorization: 'Bearer ' + key },
    body: { url }
  });
  const content = typeof data?.markdown === 'string' ? data.markdown : String(data?.markdown?.raw_markdown || data?.markdown?.fit_markdown || data?.data?.markdown || '');
  return { title: clean(data?.title || data?.metadata?.title), url: data?.url || url, content: content.trim() };
}

const PAGE_READERS = [
  ['jina', null, readWithJina],            // works keyless (20/min), 500/min with key
  ['firecrawl', 'FIRECRAWL_API_KEY', readWithFirecrawl],
  ['crawl4ai', 'CRAWL4AI_KEY', readWithCrawl4ai]
];

/**
 * Reads one public page as clean text. Jina answers first; if it has not
 * answered within a short hedge, the keyed readers join the race, so a slow or
 * blocked reader never leaves the caller waiting for the full timeout.
 */
export async function readPage(url, { timeoutMs = 8000, hedgeMs = 1800, minChars = 120 } = {}) {
  let done = false;
  const attempts = PAGE_READERS.map(([name, keyName, run], index) => (async () => {
    if (keyName && !env(keyName)) throw Object.assign(new Error(name + ' not configured'), { status: 412 });
    const id = 'read:' + name;
    if (cooldowns.isCoolingDown(id)) throw Object.assign(new Error(name + ' cooling down'), { status: 503 });
    if (index > 0) {
      await new Promise(resolve => setTimeout(resolve, hedgeMs * index));
      if (done) throw Object.assign(new Error('not needed'), { status: 499 });
    }
    try {
      const page = await run(url, { timeoutMs: Math.max(2500, timeoutMs - hedgeMs * index) });
      if (String(page.content || '').length < minChars) throw Object.assign(new Error(name + ' returned too little text'), { status: 502 });
      cooldowns.clear(id);
      console.info('[WEB_PROVIDERS] page reader succeeded', { provider: name, chars: page.content.length });
      return { ...page, provider: name };
    } catch (err) {
      const status = statusOf(err);
      if (![502, 499].includes(status)) coolKey(id, status);
      if (status !== 499) console.warn('[WEB_PROVIDERS] page reader failed', { provider: name, status, message: String(err?.message || err).slice(0, 160) });
      throw err;
    }
  })());
  try {
    return await Promise.any(attempts);
  } catch {
    throw Object.assign(new Error('No page reader could read ' + String(url).slice(0, 120)), { status: 503 });
  } finally {
    done = true;
  }
}

/** Reads several pages in parallel and returns the ones that produced text. */
export async function readPages(urls, options = {}) {
  const settled = await Promise.allSettled((urls || []).map(url => readPage(url, options)));
  return settled.filter(x => x.status === 'fulfilled').map(x => x.value);
}

// ---------- Image understanding (Cloudflare Workers AI, OpenRouter) ----------

let cloudflareAccountId = '';
async function resolveCloudflareAccountId(token) {
  if (env('CLOUDFLARE_ACCOUNT_ID')) return env('CLOUDFLARE_ACCOUNT_ID');
  if (cloudflareAccountId) return cloudflareAccountId;
  // The account ID is not secret and can be discovered with the token itself,
  // so only CLOUDFLARE_API_TOKEN is required.
  const data = await fetchJson('https://api.cloudflare.com/client/v4/accounts?per_page=5', {
    timeoutMs: 4000, label: 'Cloudflare accounts', headers: { authorization: 'Bearer ' + token }
  });
  cloudflareAccountId = String(data?.result?.[0]?.id || '');
  if (!cloudflareAccountId) throw Object.assign(new Error('Cloudflare token cannot list an account; set CLOUDFLARE_ACCOUNT_ID'), { status: 412 });
  return cloudflareAccountId;
}

export async function describeImageWithCloudflare(bytes, mime, prompt, { timeoutMs = 12000 } = {}) {
  const token = env('CLOUDFLARE_API_TOKEN');
  if (!token) throw Object.assign(new Error('Cloudflare token not configured'), { status: 412 });
  const accountId = await resolveCloudflareAccountId(token);
  const model = env('CLOUDFLARE_VISION_MODEL') || '@cf/meta/llama-4-scout-17b-16e-instruct';
  const data = await fetchJson('https://api.cloudflare.com/client/v4/accounts/' + accountId + '/ai/run/' + model, {
    method: 'POST', timeoutMs, label: 'Cloudflare vision',
    headers: { authorization: 'Bearer ' + token },
    body: {
      max_tokens: 700,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64') } }
      ] }]
    }
  });
  const text = String(data?.result?.response || '').trim();
  if (!text) throw Object.assign(new Error('Cloudflare vision returned empty output'), { status: 502 });
  return text;
}

export async function describeImageWithOpenRouter(bytes, mime, prompt, { timeoutMs = 12000 } = {}) {
  const key = env('OPENROUTER_API_KEY');
  if (!key) throw Object.assign(new Error('OpenRouter key not configured'), { status: 412 });
  const model = env('OPENROUTER_VISION_MODEL') || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
  const data = await fetchJson('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', timeoutMs, label: 'OpenRouter vision',
    headers: { authorization: 'Bearer ' + key },
    body: {
      model, max_tokens: 900,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64') } }
      ] }]
    }
  });
  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw Object.assign(new Error('OpenRouter vision returned empty output'), { status: 502 });
  return text;
}

/** Independent image understanding used when Gemini is unavailable. */
export async function describeImageIndependently(bytes, mime, prompt, { timeoutMs = 12000 } = {}) {
  const racers = [];
  if (env('CLOUDFLARE_API_TOKEN')) racers.push(describeImageWithCloudflare(bytes, mime, prompt, { timeoutMs }).then(text => ({ provider: 'cloudflare', text })));
  if (env('OPENROUTER_API_KEY')) racers.push(describeImageWithOpenRouter(bytes, mime, prompt, { timeoutMs }).then(text => ({ provider: 'openrouter', text })));
  if (!racers.length) throw Object.assign(new Error('No independent vision provider configured'), { status: 503 });
  try {
    return await Promise.any(racers);
  } catch (err) {
    for (const e of err?.errors || []) console.warn('[WEB_PROVIDERS] vision provider failed', { status: statusOf(e), message: String(e?.message || e).slice(0, 160) });
    throw Object.assign(new Error('All independent vision providers failed'), { status: 503 });
  }
}

// ---------- Health check (no secrets, cached so it spends almost no credit) ----------

let lastHealth = null;
let healthRunning = null;
const HEALTH_TTL_MS = 6 * 60 * 60 * 1000;

async function probe(name, configured, run) {
  if (!configured) return [name, { configured: false }];
  const started = Date.now();
  try {
    const detail = await run();
    return [name, { configured: true, ok: true, ms: Date.now() - started, ...(detail || {}) }];
  } catch (err) {
    return [name, { configured: true, ok: false, ms: Date.now() - started, status: statusOf(err), error: String(err?.message || err).replace(/[A-Za-z0-9_-]{24,}/g, '[hidden]').slice(0, 160) }];
  }
}

export async function providerHealth({ force = false } = {}) {
  if (!force && lastHealth && Date.now() - lastHealth.checkedAtMs < HEALTH_TTL_MS) return lastHealth;
  if (healthRunning) return healthRunning;
  const query = 'ירושלים';
  healthRunning = (async () => {
    const keys = tavilyKeys();
    const checks = await Promise.all([
      probe('tavily_primary', Boolean(env('TAVILY_API_KEY')), async () => {
        const r = await tavily({ apiKey: env('TAVILY_API_KEY') }).search(query, { maxResults: 1, searchDepth: 'basic' });
        return { results: r?.results?.length || 0 };
      }),
      probe('tavily_backup', Boolean(env('TAVILY_BACKUP_API_KEY')), async () => {
        const r = await tavily({ apiKey: env('TAVILY_BACKUP_API_KEY') }).search(query, { maxResults: 1, searchDepth: 'basic' });
        return { results: r?.results?.length || 0 };
      }),
      probe('langsearch', Boolean(env('LANGSEARCH_API_KEY')), async () => ({ results: (await searchLangSearch(query, { count: 1 })).length })),
      probe('serper', Boolean(env('SERPER_API_KEY')), async () => ({ results: (await searchSerper(query, { count: 1 })).length })),
      probe('jina', Boolean(env('JINA_API_KEY')), async () => ({ chars: (await readWithJina('https://example.com')).content.length })),
      probe('firecrawl', Boolean(env('FIRECRAWL_API_KEY')), async () => ({ chars: (await readWithFirecrawl('https://example.com')).content.length })),
      probe('crawl4ai', Boolean(env('CRAWL4AI_KEY')), async () => ({ chars: (await readWithCrawl4ai('https://example.com')).content.length })),
      probe('cloudflare', Boolean(env('CLOUDFLARE_API_TOKEN')), async () => ({ accountResolved: Boolean(await resolveCloudflareAccountId(env('CLOUDFLARE_API_TOKEN'))) }))
    ]);
    lastHealth = { checkedAt: new Date().toISOString(), checkedAtMs: Date.now(), tavilyKeys: keys.length, providers: Object.fromEntries(checks) };
    console.info('[WEB_PROVIDERS] health check', JSON.stringify(lastHealth.providers));
    return lastHealth;
  })().finally(() => { healthRunning = null; });
  return healthRunning;
}
