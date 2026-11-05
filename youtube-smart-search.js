// Smart search for extension 2: the caller's words come from speech
// recognition (names are often misheard, filler words, "תחפש לי את השיר
// של..."). A fast language model turns them into the search YouTube
// understands best; both that search and the caller's own words are used and
// merged, so a wrong rewrite can never hide what the caller actually said.
// Never throws: without the model it is the plain search.
import { searchYouTubeVideos } from './youtube-ivr.js';

export async function rewriteSearchQuery(spoken, env = process.env, fetchImpl = fetch) {
  const text = String(spoken || '').trim();
  const key = String(env.GROQ_API_KEY || '').trim();
  if (!text || !key) return null;
  try {
    const r = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(Number(env.SMART_SEARCH_TIMEOUT_MS || 3500)),
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.SMART_SEARCH_MODEL || 'llama-3.3-70b-versatile', temperature: 0, max_tokens: 80,
        messages: [
          { role: 'system', content: 'אתה עוזר חיפוש ביוטיוב לקו טלפון. תקבל תמלול של בקשה קולית בעברית (ייתכנו שגיאות שמיעה בשמות של זמרים, רבנים, ערוצים ושירים). החזר רק את מחרוזת החיפוש הטובה ביותר ליוטיוב: תקן שמות שנשמעו לא נכון לכתיב הנכון והמוכר, הסר מילות פנייה כמו "תחפש לי" "אני רוצה לשמוע" "תשמיע", השאר את שם השיר והאמן או הנושא, ואם ביקשו "חדש" או "האחרון" השאר את המילה חדש. בלי הסברים, בלי מרכאות, שורה אחת בלבד.' },
          { role: 'user', content: text },
        ],
      }),
    });
    const j = await r.json().catch(() => null);
    const out = String(j?.choices?.[0]?.message?.content || '').split('\n')[0].replace(/^["'״]+|["'״]+$/g, '').trim();
    return r.ok && out && out.length <= 120 ? out : null;
  } catch { return null; }
}

export async function smartYouTubeSearch(spoken, opts = {}, env = process.env, search = searchYouTubeVideos) {
  const rewritten = await rewriteSearchQuery(spoken, env, opts.fetchImpl);
  const queries = [...new Set([rewritten, String(spoken || '').trim()].filter(Boolean))];
  const lists = await Promise.all(queries.map(q => search(q, opts).catch(e => (q === queries[queries.length - 1] ? Promise.reject(e) : []))));
  const seen = new Set(), merged = [];
  // Interleave: best of the smart query first, then the caller's own words.
  const max = Math.max(...lists.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) { const v = l[i]; if (v && !seen.has(v.videoId)) { seen.add(v.videoId); merged.push(v); } }
  const pages = queries.map((q, i) => ({ query: q, token: lists[i]?.nextPageToken || null }));
  Object.defineProperty(merged, 'pages', { value: pages, enumerable: false });
  Object.defineProperty(merged, 'rewritten', { value: rewritten, enumerable: false });
  return merged;
}

// The next page of every query used, merged, without results already heard.
export async function moreYouTubeResults(prev, opts = {}, search = searchYouTubeVideos) {
  const pages = (prev?.pages || []).filter(p => p.token);
  if (!pages.length) return null;
  const lists = await Promise.all(pages.map(p => search(p.query, { ...opts, pageToken: p.token }).catch(() => [])));
  const seen = new Set(prev.map(v => v.videoId)), add = [];
  const max = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) { const v = l[i]; if (v && !seen.has(v.videoId)) { seen.add(v.videoId); add.push(v); } }
  const next = pages.map((p, i) => ({ query: p.query, token: lists[i]?.nextPageToken || null }));
  return { add, pages: next };
}
