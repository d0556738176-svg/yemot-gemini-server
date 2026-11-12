import { groqChat } from './groq-chat.js';
// Smart search for extension 2: the caller's words come from speech
// recognition (names are often misheard, filler words, "תחפש לי את השיר
// של..."). A fast language model turns them into the search YouTube
// understands best; both that search and the caller's own words are used and
// merged, so a wrong rewrite can never hide what the caller actually said.
// Never throws: without the model it is the plain search.
import { searchYouTubeVideos, youtubeKeysFrom } from './youtube-ivr.js';
import { webYouTubeHints, videosByIds } from './youtube-web-hints.js';

export async function rewriteSearchQuery(spoken, env = process.env, fetchImpl = fetch, hints = null) {
  const text = String(spoken || '').trim();
  if (!text) return null;
  const hintText = hints?.titles?.length
    ? '\n\nכותרות שמנוע חיפוש באינטרנט החזיר לאותן מילים (הכתיב שלהן נכון; אם אחת מהן היא בבירור מה שהמתקשר ביקש, השתמש בכתיב השמות שלה):\n- ' + hints.titles.join('\n- ') + (hints.corrected ? '\nתיקון כתיב של מנוע החיפוש: ' + hints.corrected : '')
    : '';
  const raw = await groqChat([
    { role: 'system', content: 'אתה עוזר חיפוש ביוטיוב לקו טלפון. תקבל תמלול של בקשה קולית בעברית (ייתכנו שגיאות שמיעה בשמות של זמרים, רבנים, ערוצים ושירים: אותיות שהתחלפו, מילה אחת שנשמעה כשתיים או להפך). החזר רק את מחרוזת החיפוש הטובה ביותר ליוטיוב: תקן שמות שנשמעו לא נכון לכתיב הנכון והמוכר, הסר מילות פנייה כמו "תחפש לי" "אני רוצה לשמוע" "תשמיע", השאר את שם השיר והאמן או הנושא, ואם ביקשו "חדש" או "האחרון" השאר את המילה חדש. בלי הסברים, בלי מרכאות, שורה אחת בלבד.' },
    { role: 'user', content: text + hintText }], { env, fetchImpl, maxTokens: 80, timeoutMs: Number(env.SMART_SEARCH_TIMEOUT_MS || 4000) });
  const out = String(raw || '').split('\n')[0].replace(/^["'״]+|["'״]+$/g, '').trim();
  return out && out.length <= 120 ? out : null;
}

export async function smartYouTubeSearch(spoken, opts = {}, env = process.env, search = searchYouTubeVideos, deps = {}) {
  const own = String(spoken || '').trim();
  const hintsFn = deps.webHints || webYouTubeHints, byIds = deps.videosByIds || videosByIds;
  // The caller's own words go to YouTube at once, while a web search looks
  // up how the names are really spelled (see youtube-web-hints.js).
  const ownSearch = search(own, opts).then(l => ({ l }), e => ({ e }));
  const hints = await hintsFn(own, { env, fetchImpl: opts.fetchImpl || fetch }).catch(() => null);
  const rewritten = await rewriteSearchQuery(spoken, env, opts.fetchImpl, hints);
  const apiKey = opts.apiKey || youtubeKeysFrom(env)[0];
  const [webList, rewrittenList, ownRes] = await Promise.all([
    hints?.videos?.length ? byIds(hints.videos.map(v => v.videoId), { apiKey, fetchImpl: opts.fetchImpl }).catch(() => []) : [],
    rewritten && rewritten !== own ? search(rewritten, opts).catch(() => []) : [],
    ownSearch,
  ]);
  if (ownRes.e && !webList.length && !rewrittenList.length) throw ownRes.e;
  const queries = [...new Set([rewritten, own].filter(Boolean))];
  const lists = queries.map(q => (q === own ? ownRes.l || [] : rewrittenList));
  const seen = new Set(), merged = [];
  // Interleave: best of the smart query first, then the caller's own words.
  // The web's YouTube links come first: the web search is the step that
  // corrects misheard names.
  for (const v of webList.slice(0, 5)) if (!seen.has(v.videoId)) { seen.add(v.videoId); merged.push(v); }
  const max = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) { const v = l[i]; if (v && !seen.has(v.videoId)) { seen.add(v.videoId); merged.push(v); } }
  for (const v of webList.slice(5)) if (!seen.has(v.videoId)) { seen.add(v.videoId); merged.push(v); }
  const pages = queries.map((q, i) => ({ query: q, token: lists[i]?.nextPageToken || null }));
  Object.defineProperty(merged, 'pages', { value: pages, enumerable: false });
  Object.defineProperty(merged, 'rewritten', { value: rewritten, enumerable: false });
  Object.defineProperty(merged, 'web', { value: hints ? { provider: hints.provider, videos: webList.length, corrected: hints.corrected } : null, enumerable: false });
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
