import { groqChat } from './groq-chat.js';
// Smart search for extension 2: the caller's words come from speech
// recognition (names are often misheard, filler words, "תחפש לי את השיר
// של..."). A fast language model turns them into the search YouTube
// understands best; both that search and the caller's own words are used and
// merged, so a wrong rewrite can never hide what the caller actually said.
// Never throws: without the model it is the plain search.
import { searchYouTubeVideos, youtubeKeysFrom, wantsNewestQuery } from './youtube-ivr.js';
import { webYouTubeHints, videosByIds } from './youtube-web-hints.js';

// The caller asked for English titles ("באנגלית") or spoke in English.
export function wantsEnglish(spoken) {
  const t = String(spoken || '');
  const latin = (t.match(/[A-Za-z]/g) || []).length, heb = (t.match(/[\u05D0-\u05EA]/g) || []).length;
  return /באנגלית|in english/i.test(t) || (latin > 3 && latin > heb);
}

// One model call plans the searches (owner, 13.11): the Hebrew search with the
// names spelled right, an English search (many videos have English titles even
// when described in Hebrew), and for a request by topic or style up to two
// focused searches. Plain text from the model counts as the Hebrew search.
export async function planSearch(spoken, env = process.env, fetchImpl = fetch, hints = null) {
  const text = String(spoken || '').trim();
  if (!text) return null;
  const hintText = hints?.titles?.length
    ? '\n\nכותרות שמנוע חיפוש באינטרנט החזיר לאותן מילים (הכתיב שלהן נכון; אם אחת מהן היא בבירור מה שהמתקשר ביקש, השתמש בכתיב השמות שלה):\n- ' + hints.titles.join('\n- ') + (hints.corrected ? '\nתיקון כתיב של מנוע החיפוש: ' + hints.corrected : '')
    : '';
  const raw = await groqChat([
    { role: 'system', content: 'אתה עוזר חיפוש ביוטיוב לקו טלפון. תקבל תמלול של בקשה קולית (ייתכנו שגיאות שמיעה בשמות של זמרים, רבנים, ערוצים, שירים וסרטונים: אותיות שהתחלפו, מילה אחת שנשמעה כשתיים או להפך). הבן מה המתקשר באמת מחפש והחזר JSON בלבד בשורה אחת: {"he":"...","en":"...","topics":["...","..."]}.\nhe: מחרוזת החיפוש הטובה ביותר בעברית: תקן שמות שנשמעו לא נכון לכתיב הנכון והמוכר, הסר מילות פנייה ("תחפש לי", "אני רוצה לשמוע", "תשמיע", "באנגלית"), השאר שם השיר והאמן או הנושא, ואם ביקשו "חדש" או "האחרון" השאר "חדש".\nen: אותו חיפוש באנגלית כפי שהכותרת באנגלית כנראה כתובה ביוטיוב (שמות אנשים באיות האנגלי המקובל שלהם, שם תיק/פרשה/סרט בשם המוכר באנגלית). אם זה שיר או תוכן עברי שאין לו כותרת באנגלית, כתוב את התעתיק האנגלי המקובל.\ntopics: אם בבקשה אין שם מסוים של שיר, סרטון, אמן או ערוץ (בקשה לפי נושא, סגנון, אווירה או תיאור) חובה לתת שני חיפושים קצרים וממוקדים, שונים זה מזה, במונחים שבהם סרטונים כאלה באמת נקראים ביוטיוב, ושומרים על כל תנאי שביקש (למשל "בלי כלי נגינה" = ווקאלי/אקפלה, "לילדים", "קצר"); אם יש שם מסוים, רשימה ריקה.\nבלי הסברים ובלי טקסט מחוץ ל-JSON.' },
    { role: 'user', content: text + hintText }], { env, fetchImpl, maxTokens: 160, timeoutMs: Number(env.SMART_SEARCH_TIMEOUT_MS || 4500) });
  const clean = q => { const o = String(q || '').replace(/^["'״]+|["'״]+$/g, '').replace(/\s*\b(?:YouTube|youtube)\b\s*|\s*יוטיוב\s*|\s*באנגלית\s*/g, ' ').replace(/\s+/g, ' ').trim(); return o && o.length <= 120 ? o : null; };
  const body = String(raw || '').trim();
  let j = null;
  try { j = JSON.parse((body.match(/\{[\s\S]*\}/) || [''])[0]); } catch { /* plain text */ }
  if (!j) { const he = clean(body.split('\n')[0]); return he ? { he, en: null, topics: [] } : null; }
  return { he: clean(j.he), en: clean(j.en), topics: (Array.isArray(j.topics) ? j.topics : []).map(clean).filter(Boolean).slice(0, 2) };
}

export async function rewriteSearchQuery(spoken, env = process.env, fetchImpl = fetch, hints = null) {
  return (await planSearch(spoken, env, fetchImpl, hints))?.he || null;
}

export async function smartYouTubeSearch(spoken, opts = {}, env = process.env, search = searchYouTubeVideos, deps = {}) {
  const own = String(spoken || '').trim();
  const english = wantsEnglish(own);
  // "The newest video of X": the caller's own words find X's channel and its
  // uploads in date order. That order is the answer, so no English or topic
  // searches and no reordering by sound (owner, 13.11).
  const newest = wantsNewestQuery(own);
  const hintsFn = deps.webHints || webYouTubeHints, byIds = deps.videosByIds || videosByIds;
  // The caller's own words go to YouTube at once, while a web search looks
  // up how the names are really spelled (see youtube-web-hints.js).
  const ownSearch = search(own, opts).then(l => ({ l }), e => ({ e }));
  const hints = await hintsFn(own, { env, fetchImpl: opts.fetchImpl || fetch }).catch(() => null);
  const plan = await planSearch(spoken, env, opts.fetchImpl, hints).catch(() => null);
  const rewritten = plan?.he || null;
  const apiKey = opts.apiKey || youtubeKeysFrom(env)[0];
  // Every planned search runs at once (Hebrew, English, topics), each only once.
  const heNewest = newest && rewritten && !wantsNewestQuery(rewritten) ? rewritten + ' החדש' : rewritten;
  const extra = [...new Set((newest ? [heNewest] : [heNewest, plan?.en, ...(plan?.topics || [])]).filter(q => q && q !== own))];
  const [webList, ownRes, ...extraLists] = await Promise.all([
    hints?.videos?.length ? byIds(hints.videos.map(v => v.videoId), { apiKey, fetchImpl: opts.fetchImpl }).catch(() => []) : [],
    ownSearch,
    ...extra.map(q => search(q, opts).catch(() => [])),
  ]);
  if (ownRes.e && !webList.length && !extraLists.some(l => l.length)) throw ownRes.e;
  const listOf = q => (q === own ? ownRes.l || [] : extraLists[extra.indexOf(q)] || []);
  const queries = [...new Set((newest ? [own, heNewest] : [heNewest, plan?.en, ...(plan?.topics || []), own]).filter(Boolean))];
  // Order of the merge: asked in English -> the English search leads;
  // otherwise web links, the Hebrew search, the topic searches, the caller's
  // own words, and the English search last.
  const order = newest
    ? [own, heNewest]
    : english
      ? [plan?.en, heNewest, ...(plan?.topics || []), own]
      : [heNewest, ...(plan?.topics || []), own, plan?.en];
  const lists = [...new Set(order.filter(Boolean))].map(listOf);
  // Newest: the channel's own list first, one after another (not interleaved).
  if (newest) {
    const seenN = new Set(), mergedN = [];
    for (const l of [...lists, webList]) for (const v of l) if (v && !seenN.has(v.videoId)) { seenN.add(v.videoId); mergedN.push(v); }
    Object.defineProperty(mergedN, 'pages', { value: queries.map(q => ({ query: q, token: listOf(q)?.nextPageToken || null })), enumerable: false });
    Object.defineProperty(mergedN, 'rewritten', { value: rewritten, enumerable: false });
    Object.defineProperty(mergedN, 'plan', { value: plan ? { ...plan, english, newest } : { newest }, enumerable: false });
    Object.defineProperty(mergedN, 'web', { value: hints ? { provider: hints.provider, videos: webList.length, corrected: hints.corrected } : null, enumerable: false });
    return mergedN;
  }
  const all = english ? [lists[0] || [], webList, ...lists.slice(1)] : [webList, ...lists];
  const seen = new Set(), merged = [];
  const max = Math.max(0, ...all.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of all) { const v = l[i]; if (v && !seen.has(v.videoId)) { seen.add(v.videoId); merged.push(v); } }
  // Titles that sound like the request move up (live 12.11). The English
  // search counts here only when the caller asked in English (owner, 13.11).
  rankBySound(merged, [own, rewritten, hints?.corrected, english ? plan?.en : null].filter(Boolean));
  const pages = queries.map(q => ({ query: q, token: listOf(q)?.nextPageToken || null }));
  Object.defineProperty(merged, 'pages', { value: pages, enumerable: false });
  Object.defineProperty(merged, 'rewritten', { value: rewritten, enumerable: false });
  Object.defineProperty(merged, 'plan', { value: plan ? { ...plan, english } : null, enumerable: false });
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
