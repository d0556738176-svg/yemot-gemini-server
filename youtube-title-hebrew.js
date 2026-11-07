// Search results read in Hebrew (owner, 07.11: he does not read English).
// For every result whose title is not Hebrew, one short language-model call
// per page of results gives: the title translated into Hebrew, the channel
// name in Hebrew letters as it sounds, and the language of the title. The
// original title is kept (file names, metadata); only what is spoken changes.
// Never throws and never delays a page by more than the timeout.
import { groqChat } from './groq-chat.js';

const HEB = /[א-ת]/;
const cache = new Map(); // videoId -> { t, c, l }

const FOREIGN = /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\u4e00-\u9fff\u3040-\u30ff]/g;
function foreign(t) { t = String(t || ''); return !HEB.test(t) && (t.match(FOREIGN) || []).length >= 2; }
// A title or a channel name not in Hebrew letters (both are read aloud).
export function needsHebrew(v) {
  return foreign(v?.title) || foreign(v?.channelTitle);
}

function parse(text, n) {
  const s = String(text || '');
  try {
    const a = JSON.parse(s.slice(s.indexOf('['), s.lastIndexOf(']') + 1));
    if (Array.isArray(a) && a.length === n) return a;
  } catch { /* not usable */ }
  return null;
}

const SYSTEM = 'You receive a JSON array of YouTube results {title, channel}. For each, return {"t": the title translated into short natural Hebrew (people, bands and places written in Hebrew letters), "c": the channel name written in Hebrew letters as it sounds (not translated), "l": the language of the title, as a Hebrew word such as "אנגלית", "יידיש", "ערבית", "רוסית", "צרפתית", "ספרדית"}. Return only a JSON array of the same length and order.';

// Adds heTitle / heChannel / langName to the given videos (those not in Hebrew).
export async function hebrewizeResults(videos, { env = process.env, fetchImpl = fetch, timeoutMs = 4500, log = console } = {}) {
  const todo = (videos || []).filter(v => v && needsHebrew(v) && !v.heTitle);
  for (const v of todo) { const c = cache.get(v.videoId); if (c) Object.assign(v, { heTitle: c.t, heChannel: c.c, langName: c.l }); }
  const rest = todo.filter(v => !v.heTitle);
  if (!rest.length) return videos;
  const t0 = Date.now();
  const out = parse(await groqChat([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify(rest.map(v => ({ title: String(v.title || '').slice(0, 200), channel: String(v.channelTitle || '').slice(0, 80) }))) },
  ], { env, fetchImpl, maxTokens: 120 + rest.length * 90, timeoutMs }), rest.length);
  if (!out) { log.warn?.('[YouTube IVR] result titles not translated this time', { count: rest.length, ms: Date.now() - t0 }); return videos; }
  rest.forEach((v, i) => {
    const r = out[i] || {};
    let t = String(r.t || '').trim(); const c = String(r.c || '').trim(), l = String(r.l || '').trim();
    if (!foreign(v.title)) t = String(v.title); // the title was Hebrew already
    if (!HEB.test(t)) return;
    const entry = { t, c: HEB.test(c) ? c : '', l: HEB.test(l) && l !== 'עברית' ? l : '' };
    cache.set(v.videoId, entry);
    Object.assign(v, { heTitle: entry.t, heChannel: entry.c, langName: entry.l });
  });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  log.info?.('[YouTube IVR] result titles read in Hebrew', { count: rest.length, ms: Date.now() - t0 });
  return videos;
}

// What is spoken for a result: the Hebrew title (+ its language) when there is one.
export function spokenTitle(v) {
  if (v?.heTitle && foreign(v.title)) return v.heTitle + (v.langName ? ', סרטון ב' + v.langName : '');
  if (v?.heTitle) return v.heTitle;
  return String(v?.title || '');
}
export function spokenChannel(v) {
  return v?.heChannel || String(v?.channelTitle || '');
}
