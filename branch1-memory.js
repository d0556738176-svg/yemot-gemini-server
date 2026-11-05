import { groqChat } from './groq-chat.js';
// Extension 1: durable memory of every caller's conversations.
//
// Found 05.11: memory lived only in the server's RAM (Supabase is not
// configured on this service), and the free server starts a NEW instance after
// each idle period, so every call began with an empty memory
// ("caller_memory_status ... hasMemory: false" on every call, never
// "returning_caller_memory_found"). Now each caller's conversation is kept in
// the Yemot account itself (one small JSON file per phone number, folder
// ivr2:/ai_memory), loaded when the call starts and updated after every
// answer. Older turns are folded into a short written summary so the memory
// never stops growing in usefulness but stays small.
const API = 'https://www.call2all.co.il/ym/api';
const DIR = 'ivr2:/ai_memory';
export const KEEP_TURNS = 60;      // full turns kept word for word
const SUMMARIZE_AT = 80;           // above this, the oldest turns are summarized

function token(env = process.env) {
  const t = String(env.YEMOT_TOKEN || '').trim();
  if (t) return t;
  const u = String(env.YEMOT_API_USERNAME || '').trim(), p = String(env.YEMOT_API_PASSWORD || '').trim();
  return u && p ? u + ':' + p : '';
}
export function memoryPath(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  return digits.length >= 5 ? DIR + '/' + digits + '.json' : null;
}

export async function readMemory(phone, { env = process.env, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const path = memoryPath(phone), tk = token(env);
  if (!path || !tk) return null;
  const u = new URL(API + '/DownloadFile'); u.searchParams.set('token', tk); u.searchParams.set('path', path);
  const r = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) return null;
  const text = await r.text();
  try { const j = JSON.parse(text); return j && Array.isArray(j.entries) ? j : null; } catch { return null; }
}

export async function writeMemory(phone, data, { env = process.env, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const path = memoryPath(phone), tk = token(env);
  if (!path || !tk) return false;
  const u = new URL(API + '/UploadFile');
  u.searchParams.set('token', tk); u.searchParams.set('path', path);
  u.searchParams.set('convertAudio', '0'); u.searchParams.set('autoNumbering', 'false');
  const form = new FormData();
  form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), 'memory.json');
  const r = await fetchImpl(u, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => null);
  return r.ok && j?.responseStatus === 'OK';
}

// Folds the oldest turns into the written summary (language model, fast
// provider first). Without a model the oldest turns are kept as short lines.
export async function summarize(previousSummary, turns, { env = process.env, fetchImpl = fetch } = {}) {
  const lines = turns.map(t => 'מתקשר: ' + String(t.user || '').slice(0, 300) + '\nתשובה: ' + String(t.gemini || '').slice(0, 300)).join('\n');
  const out = await groqChat([
    { role: 'system', content: 'אתה מנהל זיכרון של עוזר טלפוני. כתוב סיכום עדכני וקצר בעברית (עד 15 שורות) של כל מה שחשוב לזכור על המתקשר משיחות קודמות: מי הוא, מה ביקש, העדפות, נושאים פתוחים, פרטים שמסר ותשובות חשובות שקיבל. שלב את הסיכום הקודם עם השיחות החדשות. אל תמציא.' },
    { role: 'user', content: 'סיכום קודם:\n' + (previousSummary || 'אין') + '\n\nשיחות נוספות:\n' + lines }], { env, fetchImpl, maxTokens: 700, timeoutMs: 20000 });
  if (out) return out.slice(0, 3000);
  const short = turns.map(t => '- ' + String(t.user || '').slice(0, 120)).join('\n');
  return ((previousSummary ? previousSummary + '\n' : '') + 'נושאים קודמים:\n' + short).slice(-3000);
}

// Serialized per caller so two quick answers never overwrite each other.
const chains = new Map();
export function rememberTurn(phone, entry, opts = {}) {
  const key = String(phone || '');
  const prev = chains.get(key) || Promise.resolve();
  const job = prev.then(async () => {
    const mem = (await readMemory(phone, opts).catch(() => null)) || { phone: key, summary: '', entries: [] };
    mem.entries.push({ time: entry.time, callId: entry.callId, user: entry.user, gemini: entry.gemini });
    if (mem.entries.length > SUMMARIZE_AT) {
      const old = mem.entries.splice(0, mem.entries.length - KEEP_TURNS);
      mem.summary = await summarize(mem.summary, old, opts);
    }
    mem.updatedAt = new Date().toISOString();
    return writeMemory(phone, mem, opts);
  });
  chains.set(key, job.catch(() => {}));
  return job;
}
