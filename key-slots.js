// Owner, 12.11: every key can have replacement fields in Render. For a key
// named X_API_KEY the server also reads X_BACKUP_API_KEY and X_API_KEY_2 ..
// X_API_KEY_9; when one key is out of quota or rejected, the next one is used.
// Key values are never logged: only field names and statuses.

const env = name => String(process.env[name] || '').trim();
export const SLOT_NUMBERS = [2, 3, 4, 5, 6, 7, 8, 9];

export function slotNames(base) {
  const backup = base.includes('_API_KEY') ? base.replace('_API_KEY', '_BACKUP_API_KEY') : base + '_BACKUP';
  return [base, backup, ...SLOT_NUMBERS.map(n => base + '_' + n)];
}
// [{name, key}] for the fields that are set, without repeating a key.
export function keySlots(base) {
  const seen = new Set(), out = [];
  for (const name of slotNames(base)) { const key = env(name); if (key && !seen.has(key)) { seen.add(key); out.push({ name, key }); } }
  return out;
}
export const keysFor = base => keySlots(base).map(x => x.key);

// A key that ran out (quota, rejected) rests; a rate-limited one rests briefly.
const resting = new Map();
function restKey(key, status, message) {
  const quota = /quota|exceed|limit|credit|insufficient|billing|plan/i.test(String(message || ''));
  const ms = status === 401 || status === 403 || status === 402 || status === 432 || status === 433 || quota ? 6 * 3600e3 : status === 429 ? 60e3 : 0;
  if (ms) resting.set(key, Date.now() + ms);
}
const isResting = key => (resting.get(key) || 0) > Date.now();

// Runs fn(key) with the first usable key; on a quota/limit/auth failure moves to the next one.
export async function withKeys(base, fn, { label = base } = {}) {
  const slots = keySlots(base);
  if (!slots.length) throw Object.assign(new Error(label + ' key not configured'), { status: 412 });
  const order = [...slots.filter(s => !isResting(s.key)), ...slots.filter(s => isResting(s.key))];
  let last;
  for (const s of order) {
    try { return await fn(s.key, s.name); }
    catch (e) {
      last = e;
      const status = Number(e?.status || e?.statusCode || 0);
      const msg = String(e?.message || e);
      if ([401, 402, 403, 429, 432, 433].includes(status) || /quota|exceed|credit|insufficient|usage limit/i.test(msg)) {
        restKey(s.key, status, msg);
        if (order.length > 1) console.info('[KEYS] moving to the next key', { field: s.name, status });
        continue;
      }
      throw e;
    }
  }
  throw last;
}

// ---------- startup report ----------
async function call(url, opts = {}, timeoutMs = 15000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  let body = ''; try { body = await r.text(); } catch {}
  return { status: r.status, body: body.slice(0, 300) };
}
function verdict({ status, body }) {
  if (status >= 200 && status < 300) return 'ok';
  // The provider's own reason (never contains the key itself); quotes and URLs dropped.
  const why = ' | ' + String(body || '').replace(/sk-[A-Za-z0-9_-]{6,}|AIza[0-9A-Za-z_-]{10,}|gsk_[A-Za-z0-9]{6,}/g, '[key]').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').slice(0, 160);
  return verdictOnly({ status, body }) + why;
}
function verdictOnly({ status, body }) {
  if (/quota|exceed|credit|insufficient|usage limit|limit reached|billing/i.test(body) || status === 402 || status === 432 || status === 433) return 'out of quota';
  if (status === 429) return 'busy now (rate limit)';
  if (status === 401 || status === 403) return 'rejected (wrong or disabled key)';
  return 'error ' + status;
}
const chat = (base, model) => key => call(base + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) });
const PROBES = {
  GROQ_API_KEY: chat('https://api.groq.com/openai/v1', 'openai/gpt-oss-20b'),
  OPENROUTER_API_KEY: chat('https://openrouter.ai/api/v1', 'openrouter/free'),
  MISTRAL_API_KEY: chat('https://api.mistral.ai/v1', 'mistral-small-latest'),
  CEREBRAS_API_KEY: chat('https://api.cerebras.ai/v1', 'gpt-oss-120b'),
  SAMBANOVA_API_KEY: chat('https://api.sambanova.ai/v1', 'gpt-oss-120b'),
  ZAI_API_KEY: chat('https://api.z.ai/api/paas/v4', 'glm-4.5-flash'),
  COHERE_API_KEY: chat('https://api.cohere.ai/compatibility/v1', 'command-a-03-2025'),
  // Key validity (the model list); quota is seen in real calls.
  GEMINI_API_KEY: key => call('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=' + encodeURIComponent(key)),
  TAVILY_API_KEY: key => call('https://api.tavily.com/search', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'ירושלים', max_results: 1 }) }),
  SERPER_API_KEY: key => call('https://google.serper.dev/search', { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ q: 'ירושלים', num: 1 }) }),
  LANGSEARCH_API_KEY: key => call('https://api.langsearch.com/v1/web-search', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'ירושלים', count: 1 }) }),
  EXA_API_KEY: key => call('https://api.exa.ai/search', { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Jerusalem', numResults: 1 }) }),
  JINA_API_KEY: key => call('https://r.jina.ai/https://example.com', { headers: { authorization: 'Bearer ' + key } }),
  FIRECRAWL_API_KEY: key => call('https://api.firecrawl.dev/v1/scrape', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'] }) }, 15000),
  YOUTUBE_API_KEY: key => call('https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=' + encodeURIComponent(key)),
  DEEPGRAM_API_KEY: key => call('https://api.deepgram.com/v1/projects', { headers: { authorization: 'Token ' + key } })
};
export async function keyReport() {
  const rows = [];
  for (const [base, probe] of Object.entries(PROBES)) {
    const slots = keySlots(base);
    if (!slots.length) { rows.push({ field: base, status: 'missing' }); continue; }
    for (const s of slots) {
      let status;
      try { status = verdict(await probe(s.key)); }
      catch (e) {
        // A slow first answer is retried once with more time before calling it dead.
        try { status = verdict(await Promise.race([probe(s.key), new Promise((_, j) => setTimeout(() => j(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 25000))])); }
        catch (e2) { status = 'no answer (' + String(e2?.name || e?.name || 'error') + ')'; }
      }
      // Key text with spaces, quotes or line breaks inside is a paste problem.
      if (/[\s"'<>]/.test(String(process.env[s.name] || '').trim())) status += ' (the value has spaces or quotes inside: paste the key again)';
      rows.push({ field: s.name, status });
    }
  }
  // Fields that look like keys but no part of the server reads (often a typo in the name).
  const known = new Set(Object.keys(PROBES).flatMap(slotNames));
  const extra = Object.keys(process.env).filter(n => /(KEY|TOKEN)/.test(n) && !known.has(n)).sort();
  rows.push({ field: 'OTHER KEY-LIKE FIELDS (names only)', status: extra.join(', ') || 'none' });
  for (const r of rows) console.info('[KEY_REPORT] ' + r.field + ': ' + r.status);
  return rows;
}
