// Owner, 24.11: which answer models really work right now, and (with ?q=) how
// each one answers the same question, to choose the best one by facts.
// Read-only; returns names, answer codes, times and answer text only - never a
// key. Every model is asked once, all at the same time, 20 s at most.
import { keySlots } from './key-slots.js';

const GEMINI_DEFAULT = 'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite';
function compatible(env) {
  const out = [];
  const add = (name, baseUrl, keyEnv, models) => keySlots(keyEnv).slice(0, 1).forEach(s => models.forEach(model => out.push({ name, baseUrl, key: s.key, model })));
  add('Groq', 'https://api.groq.com/openai/v1', 'GROQ_API_KEY', [...new Set([env.GROQ_ACCURATE_MODEL || 'openai/gpt-oss-120b', env.GROQ_MODEL || 'openai/gpt-oss-20b', ...String(env.GROQ_EXTRA_MODELS || '').split(',').map(x => x.trim()).filter(Boolean)])]);
  add('OpenRouter', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY', [env.OPENROUTER_MODEL || 'openrouter/free']);
  add('Mistral', 'https://api.mistral.ai/v1', 'MISTRAL_API_KEY', [env.MISTRAL_MODEL || 'mistral-small-latest']);
  add('Cerebras', 'https://api.cerebras.ai/v1', 'CEREBRAS_API_KEY', [env.CEREBRAS_MODEL || 'gpt-oss-120b']);
  add('SambaNova', 'https://api.sambanova.ai/v1', 'SAMBANOVA_API_KEY', [env.SAMBANOVA_MODEL || 'gpt-oss-120b']);
  add('ZAI', 'https://api.z.ai/api/paas/v4', 'ZAI_API_KEY', [env.ZAI_MODEL || 'glm-4.5-flash']);
  add('Cohere', 'https://api.cohere.ai/compatibility/v1', 'COHERE_API_KEY', [env.COHERE_MODEL || 'command-a-03-2025']);
  add('AionLabs', 'https://api.aionlabs.ai/v1', 'AIONLABS_API_KEY', [env.AIONLABS_MODEL || 'aion-labs/aion-3.5-mini']);
  return out;
}
export async function modelHealth({ env = process.env, q = '', fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const prompt = q ? 'ענה בעברית, בקצרה ובדיוק. אם אינך בטוח, אמור שאינך בטוח.\n' + q : 'ענה במילה אחת: כן';
  const geminiKeys = [...new Set([...(env.GEMINI_API_KEYS || env.GEMINI_API_KEY || '').split(','), ...[2, 3, 4, 5, 6, 7, 8, 9].map(n => env['GEMINI_API_KEY_' + n] || ''), env.GEMINI_BACKUP_API_KEY || ''].map(k => k.trim()).filter(Boolean))];
  const geminiModels = [...new Set([...(env.GEMINI_MODELS || GEMINI_DEFAULT).split(',').map(x => x.trim()).filter(Boolean), 'gemini-3.6-flash', 'gemini-3.5-flash-lite'])];
  const jobs = [];
  // Every Gemini model on the first key; then the first model on every key (are the keys alive?).
  geminiModels.forEach(m => jobs.push({ name: 'Gemini key1', model: m, key: geminiKeys[0], gemini: true }));
  geminiKeys.slice(1).forEach((k, i) => jobs.push({ name: 'Gemini key' + (i + 2), model: geminiModels[0], key: k, gemini: true }));
  if (q) geminiModels.slice(0, 2).forEach(m => jobs.push({ name: 'Gemini+search key1', model: m, key: geminiKeys[0], gemini: true, search: true }));
  for (const p of compatible(env)) jobs.push(p);
  const run = async j => {
    const t0 = Date.now();
    try {
      let r, text = '';
      if (j.gemini) {
        if (!j.key) return { name: j.name, model: j.model, ok: false, status: 'no key' };
        const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: q ? 900 : 20, temperature: 0.2 }, ...(j.search ? { tools: [{ googleSearch: {} }] } : {}) };
        r = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(j.model) + ':generateContent', { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { 'x-goog-api-key': j.key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const js = await r.json().catch(() => null);
        text = (js?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
        if (!r.ok) text = String(js?.error?.message || '').slice(0, 120);
      } else {
        const oss = /gpt-oss/.test(j.model);
        const body = { model: j.model, temperature: 0.2, max_tokens: q ? 1200 : 300, messages: [{ role: 'user', content: prompt }], ...(oss ? { reasoning_effort: 'low' } : {}) };
        r = await fetchImpl(j.baseUrl + '/chat/completions', { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { authorization: 'Bearer ' + j.key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const js = await r.json().catch(() => null);
        text = String(js?.choices?.[0]?.message?.content || '').trim();
        if (!r.ok) text = String(js?.error?.message || js?.message || '').slice(0, 120);
      }
      return { name: j.name, model: j.model, ok: r.ok && !!text, status: r.status, ms: Date.now() - t0, answer: text.replace(/sk-[\w-]+|AIza[\w-]+/g, '[x]').slice(0, q ? 700 : 60) };
    } catch (e) { return { name: j.name, model: j.model, ok: false, status: String(e?.name || 'error'), ms: Date.now() - t0 }; }
  };
  return { at: new Date().toISOString(), question: q || null, geminiKeys: geminiKeys.length, results: await Promise.all(jobs.map(run)) };
}
