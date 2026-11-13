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
  const out = String(raw || '').split('\n')[0].replace(/^["'״]+|["'״]+$/g, '').replace(/\s*\b(?:YouTube|youtube)\b\s*|\s*יוטיוב\s*/g, ' ').replace(/\s+/g, ' ').trim();
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
  // Everything found (web links, the rewritten search, the caller's own
  // words) is merged, then the titles that sound most like what the caller
  // said go first (live 12.11: an unrelated web link was first and the right
  // song third).
  const all = [webList, ...lists];
  const max = Math.max(0, ...all.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of all) { const v = l[i]; if (v && !seen.has(v.videoId)) { seen.add(v.videoId); merged.push(v); } }
  rankBySound(merged, [own, rewritten, hints?.corrected].filter(Boolean));
  const pages = queries.map((q, i) => ({ query: q, token: lists[i]?.nextPageToken || null }));
  Object.defineProperty(merged, 'pages', { value: pages, enumerable: false });
  Object.defineProperty(merged, 'rewritten', { value: rewritten, enumerable: false });
  Object.defineProperty(merged, 'web', { value: hints ? { provider: hints.provider, videos: webList.length, corrected: hints.corrected } : null, enumerable: false });
  return merged;
}

// How much a title sounds like what was said: speech recognition splits or
// joins words and confuses similar letters, so both sides are reduced to a
// letter skeleton (no spaces, final letters, vowels-letters or niqqud, similar
// sounds merged) and compared by the share of the request's letter triples
// found in the title.
const SOUND = { 'ץ': 'צ', 'ם': 'מ', 'ן': 'נ', 'ך': 'כ', 'ף': 'פ', 'ק': 'כ', 'ת': 'ט', 'ש': 'ס', 'ע': 'א', 'ה': 'א', 'ח': 'כ', 'ו': '', 'י': '' };
export function soundSkeleton(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0591-\u05C7]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '').split('').map(c => (c in SOUND ? SOUND[c] : c)).join('');
}
const FILLER = /(?:^|\s)(?:תחפש|חפש|תשמיע|השמע|לי|את|השיר|שיר|של|אני|רוצה|לשמוע|בבקשה)(?=\s|$)/g;
export function soundScore(query, title) {
  const q = soundSkeleton(String(query || '').replace(FILLER, ' ')), t = soundSkeleton(title);
  if (q.length < 3 || !t) return 0;
  let hit = 0, n = 0;
  for (let i = 0; i + 3 <= q.length; i++) { n++; if (t.includes(q.slice(i, i + 3))) hit++; }
  return n ? hit / n : 0;
}
// Stable: titles clearly closer to the request move up; the rest keep order.
export function rankBySound(list, queries) {
  const scored = list.map((v, i) => ({ v, i, s: Math.max(0, ...queries.map(q => soundScore(q, v.title))) }));
  const best = Math.max(0, ...scored.map(x => x.s));
  if (best < 0.5) return list; // nothing sounds like the request: keep YouTube's order
  scored.sort((a, b) => (Math.round(b.s * 5) - Math.round(a.s * 5)) || a.i - b.i);
  scored.forEach((x, k) => { list[k] = x.v; });
  return list;
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
