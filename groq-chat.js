// One short answer from Groq's chat API, robust to model retirements.
// Groq removed the llama models from this account (404 model_not_found), and
// the gpt-oss models spend tokens on hidden reasoning, so: try a list of
// models, ask for low reasoning without returning it, and allow enough tokens.
// Returns the text or null. Never throws.
export const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

const dead = new Set(); // models answered 404 in this process

export async function groqChat(messages, { env = process.env, fetchImpl = fetch, model, maxTokens = 400, timeoutMs = 5000 } = {}) {
  const key = String(env.GROQ_API_KEY || '').trim();
  if (!key) return null;
  const list = [...new Set([model, env.GROQ_MODEL, ...GROQ_MODELS].filter(Boolean))].filter(m => !dead.has(m));
  const until = Date.now() + timeoutMs;
  for (const m of list) {
    const left = until - Date.now();
    if (left < 300) break;
    try {
      const oss = /gpt-oss/.test(m);
      const body = { model: m, temperature: 0, max_tokens: oss ? Math.max(maxTokens, 600) + 400 : maxTokens, messages };
      if (oss) { body.reasoning_effort = 'low'; body.include_reasoning = false; }
      const r = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(left),
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => null);
      if (r.status === 404 || j?.error?.code === 'model_not_found') { dead.add(m); continue; }
      if (r.status === 400 && /include_reasoning|reasoning_effort/.test(JSON.stringify(j || ''))) {
        delete body.include_reasoning; delete body.reasoning_effort;
        const r2 = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST', signal: AbortSignal.timeout(Math.max(300, until - Date.now())),
          headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        const j2 = await r2.json().catch(() => null);
        const out2 = String(j2?.choices?.[0]?.message?.content || '').trim();
        if (r2.ok && out2) return out2;
        continue;
      }
      const out = String(j?.choices?.[0]?.message?.content || '').trim();
      if (r.ok && out) return out;
    } catch { /* next model */ }
  }
  return null;
}
