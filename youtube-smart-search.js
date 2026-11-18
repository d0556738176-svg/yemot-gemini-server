import { groqChat } from './groq-chat.js';
// Smart search for extension 2: the caller's words come from speech
// recognition (names are often misheard, filler words, "תחפש לי את השיר
// של..."). A fast language model turns them into the search YouTube
// understands best; both that search and the caller's own words are used and
// merged, so a wrong rewrite can never hide what the caller actually said.
// Never throws: without the model it is the plain search.
import { searchYouTubeVideos, youtubeKeysFrom, wantsNewestQuery, moreChannelUploads } from './youtube-ivr.js';
import { webYouTubeHints, videosByIds } from './youtube-web-hints.js';

// Languages the caller can ask for by saying "ב<שפה>" (owner, 13.11 + 18.11):
// "באנגלית", "ביידיש", "בצרפתית"... The search then looks for videos in that
// language: the query is written in it, YouTube is asked for it, and titles in
// its letters come first.
export const LANGUAGES = [
  ['en', 'אנגלית', 'English', 'latin'], ['yi', 'יידיש', 'Yiddish', 'hebrew'], ['fr', 'צרפתית', 'French', 'latin'],
  ['es', 'ספרדית', 'Spanish', 'latin'], ['ru', 'רוסית', 'Russian', 'cyrillic'], ['ar', 'ערבית', 'Arabic', 'arabic'],
  ['de', 'גרמנית', 'German', 'latin'], ['it', 'איטלקית', 'Italian', 'latin'], ['pt', 'פורטוגזית', 'Portuguese', 'latin'],
  ['tr', 'טורקית', 'Turkish', 'latin'], ['am', 'אמהרית', 'Amharic', 'ethiopic'], ['fa', 'פרסית', 'Persian', 'arabic'],
  ['uk', 'אוקראינית', 'Ukrainian', 'cyrillic'], ['pl', 'פולנית', 'Polish', 'latin'], ['hu', 'הונגרית', 'Hungarian', 'latin'],
  ['ro', 'רומנית', 'Romanian', 'latin'], ['nl', 'הולנדית', 'Dutch', 'latin'], ['ja', 'יפנית', 'Japanese', 'cjk'],
  ['zh', 'סינית', 'Chinese', 'cjk'], ['ko', 'קוריאנית', 'Korean', 'hangul'], ['hi', 'הודית', 'Hindi', 'devanagari'],
  ['he', 'עברית', 'Hebrew', 'hebrew'],
];
const LANG_RE = new RegExp('(?:^|[^\\p{L}])(?:ב|בשפה\\s+ה|בשפת\\s+)(' + LANGUAGES.map(l => l[1]).join('|') + ')(?=$|[^\\p{L}])', 'u');
export function requestedLanguage(spoken) {
  const t = String(spoken || '');
  const m = t.match(LANG_RE);
  if (m) { const l = LANGUAGES.find(x => x[1] === m[1]); return { code: l[0], name: l[1], english: l[2], script: l[3] }; }
  if (/\bin english\b/i.test(t)) return requestedLanguage('באנגלית');
  const latin = (t.match(/[A-Za-z]/g) || []).length, heb = (t.match(/[א-ת]/g) || []).length;
  if (latin > 3 && latin > heb) return requestedLanguage('באנגלית');
  return null;
}
// The caller asked for English titles ("באנגלית") or spoke in English.
export function wantsEnglish(spoken) { return requestedLanguage(spoken)?.code === 'en'; }
// "... בנושא", "לפי נושא", "על הנושא": a search by subject, not by a name (18.11).
export function wantsTopic(spoken) {
  return /(?:^|[^\p{L}])(?:בנושא|לפי נושא|על נושא|על הנושא|בנושאים|נושא)(?=$|[^\p{L}])/u.test(String(spoken || ''));
}
// The words that only steer the search (language, topic, newest) are not searched for.
export function withoutSteering(spoken) {
  return String(spoken || '').replace(LANG_RE, ' ').replace(/\bin english\b/gi, ' ')
    .replace(/(?:^|[^\p{L}])(?:בנושא|לפי נושא|על נושא|על הנושא|בנושאים)(?=$|[^\p{L}])/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
const SCRIPT = { latin: /[A-Za-z]/, cyrillic: /[Ѐ-ӿ]/, arabic: /[؀-ۿ]/, hebrew: /[א-ת]/, cjk: /[぀-ヿ一-鿿]/, hangul: /[가-힯]/, devanagari: /[ऀ-ॿ]/, ethiopic: /[ሀ-፿]/ };
// Is this title written in the asked language's letters (and, for a foreign
// language, without Hebrew)?
export function titleInLanguage(title, lang) {
  const t = String(title || ''), re = SCRIPT[lang?.script];
  if (!re) return false;
  if (lang.script === 'hebrew') return re.test(t);
  return re.test(t) && !SCRIPT.hebrew.test(t);
}

// One model call plans the searches (owner, 13.11): the Hebrew search with the
// names spelled right, a search in the asked language (English by default:
// many videos have English titles even when described in Hebrew), for a
// request by topic or style up to three focused searches, and for "the newest
// of X" the channel's name as YouTube shows it. Plain text from the model
// counts as the Hebrew search.
export async function planSearch(spoken, env = process.env, fetchImpl = fetch, hints = null, want = {}) {
  const text = String(spoken || '').trim();
  if (!text) return null;
  const lang = want.lang && want.lang.code !== 'he' ? want.lang : null;
  const hintText = hints?.titles?.length
    ? '\n\nכותרות שמנוע חיפוש באינטרנט החזיר לאותן מילים (הכתיב שלהן נכון; אם אחת מהן היא בבירור מה שהמתקשר ביקש, השתמש בכתיב השמות שלה):\n- ' + hints.titles.join('\n- ') + (hints.corrected ? '\nתיקון כתיב של מנוע החיפוש: ' + hints.corrected : '')
    : '';
  const langLine = lang
    ? '\nen: המתקשר ביקש סרטונים בשפה ה' + lang.name + ' (' + lang.english + '): כתוב כאן את החיפוש כולו בשפה ה' + lang.name + ' עצמה, בכתב שלה, כפי שכותרות של סרטונים בשפה הזו באמת כתובות ביוטיוב (תרגם את הנושא, ושמות אנשים באיות המקובל בשפה הזו).'
    : '\nen: אותו חיפוש באנגלית כפי שהכותרת באנגלית כנראה כתובה ביוטיוב (שמות אנשים באיות האנגלי המקובל שלהם, שם תיק/פרשה/סרט בשם המוכר באנגלית). אם זה שיר או תוכן עברי שאין לו כותרת באנגלית, כתוב את התעתיק האנגלי המקובל.';
  const topicLine = want.topic
    ? '\ntopics: המתקשר ביקש במפורש חיפוש לפי נושא. חובה לתת שלושה חיפושים קצרים וממוקדים, שונים זה מזה, במונחים שבהם סרטונים על הנושא הזה באמת נקראים ביוטיוב' + (lang ? ' (בשפה ה' + lang.name + ')' : '') + ', ושומרים על כל תנאי שביקש.'
    : '\ntopics: אם בבקשה אין שם מסוים של שיר, סרטון, אמן או ערוץ (בקשה לפי נושא, סגנון, אווירה או תיאור) חובה לתת שני חיפושים קצרים וממוקדים, שונים זה מזה, במונחים שבהם סרטונים כאלה באמת נקראים ביוטיוב, ושומרים על כל תנאי שביקש (למשל "בלי כלי נגינה" = ווקאלי/אקפלה, "לילדים", "קצר"); אם יש שם מסוים, רשימה ריקה.';
  const channelLine = want.newest
    ? '\nchannel: המתקשר ביקש את הסרטונים החדשים ביותר של ערוץ, תוכנית או אדם: כתוב את שם הערוץ ביוטיוב כפי שהוא באמת נקרא שם (למשל "ערוץ 14" הוא הערוץ "עכשיו 14"), בלי המילים "חדש", "ערוץ" כשאינה חלק מהשם, "פרק".'
    : '';
  const raw = await groqChat([
    { role: 'system', content: 'אתה עוזר חיפוש ביוטיוב לקו טלפון. תקבל תמלול של בקשה קולית (ייתכנו שגיאות שמיעה בשמות של זמרים, רבנים, ערוצים, שירים וסרטונים: אותיות שהתחלפו, מילה אחת שנשמעה כשתיים או להפך). הבן מה המתקשר באמת מחפש והחזר JSON בלבד בשורה אחת: {"he":"...","en":"...","topics":["...","..."]' + (want.newest ? ',"channel":"..."' : '') + '}.\nhe: מחרוזת החיפוש הטובה ביותר בעברית: תקן שמות שנשמעו לא נכון לכתיב הנכון והמוכר, הסר מילות פנייה ("תחפש לי", "אני רוצה לשמוע", "תשמיע") ומילים שרק מכוונות את החיפוש ("באנגלית", "ביידיש", "בנושא"), השאר שם השיר והאמן או הנושא, ואם ביקשו "חדש" או "האחרון" השאר "חדש".' + langLine + topicLine + channelLine + '\nבלי הסברים ובלי טקסט מחוץ ל-JSON.' },
    { role: 'user', content: text + hintText }], { env, fetchImpl, maxTokens: 220, timeoutMs: Number(env.SMART_SEARCH_TIMEOUT_MS || 4500) });
  const clean = q => { const o = withoutSteering(String(q || '').replace(/^["'״]+|["'״]+$/g, '').replace(/\s*\b(?:YouTube|youtube)\b\s*|\s*יוטיוב\s*/g, ' ')).replace(/\s+/g, ' ').trim(); return o && o.length <= 120 ? o : null; };
  const body = String(raw || '').trim();
  let j = null;
  try { j = JSON.parse((body.match(/\{[\s\S]*\}/) || [''])[0]); } catch { /* plain text */ }
  if (!j) { const he = clean(body.split('\n')[0]); return he ? { he, en: null, topics: [], channel: null } : null; }
  return { he: clean(j.he), en: clean(j.en), topics: (Array.isArray(j.topics) ? j.topics : []).map(clean).filter(Boolean).slice(0, want.topic ? 3 : 2), channel: want.newest ? clean(j.channel) : null };
}

export async function rewriteSearchQuery(spoken, env = process.env, fetchImpl = fetch, hints = null) {
  return (await planSearch(spoken, env, fetchImpl, hints))?.he || null;
}

function tag(list, props) {
  for (const [k, v] of Object.entries(props)) Object.defineProperty(list, k, { value: v, enumerable: false });
  return list;
}

export async function smartYouTubeSearch(spoken, opts = {}, env = process.env, search = searchYouTubeVideos, deps = {}) {
  const said = String(spoken || '').trim();
  const lang = requestedLanguage(said);
  const english = lang?.code === 'en';
  const foreign = lang && lang.code !== 'he' ? lang : null;
  const topic = wantsTopic(said);
  // "The newest video of X" / "ערוץ 14 חדש": the channel's uploads, newest
  // first to the oldest. That order is the answer, so no language or topic
  // searches and no reordering by sound (owner, 13.11 + 18.11).
  const newest = wantsNewestQuery(said);
  // The words that only steer (language, topic) are not sent to YouTube.
  const own = withoutSteering(said) || said;
  const hintsFn = deps.webHints || webYouTubeHints, byIds = deps.videosByIds || videosByIds;
  // The caller's own words go to YouTube at once, while a web search looks
  // up how the names are really spelled (see youtube-web-hints.js).
  const fxOpts = foreign ? { ...opts, relevanceLanguage: foreign.code } : opts;
  const ownSearch = search(own, newest ? { ...opts, newest: true } : fxOpts).then(l => ({ l }), e => ({ e }));
  const hints = await hintsFn(own, { env, fetchImpl: opts.fetchImpl || fetch }).catch(() => null);
  const plan = await planSearch(said, env, opts.fetchImpl, hints, { lang, topic, newest }).catch(() => null);
  const rewritten = plan?.he || null;
  const apiKey = opts.apiKey || youtubeKeysFrom(env)[0];
  const meta = (list, extra = {}) => tag(list, { rewritten, plan: plan ? { ...plan, english, lang: lang?.code || null, topic, newest } : { newest, topic, lang: lang?.code || null }, web: hints ? { provider: hints.provider, videos: 0, corrected: hints.corrected } : null, ...extra });

  if (newest) {
    // The channel as YouTube names it (from the model) is tried first, then
    // the corrected words, then the caller's own words.
    const heNewest = rewritten && !wantsNewestQuery(rewritten) ? rewritten + ' חדש' : rewritten;
    const chNewest = plan?.channel ? plan.channel + ' חדש' : null;
    const extra = [...new Set([chNewest, heNewest].filter(q => q && q !== own))];
    const [ownRes, ...extraLists] = await Promise.all([ownSearch, ...extra.map(q => search(q, { ...opts, newest: true }).catch(() => []))]);
    const named = [...extra.map((q, i) => ({ q, l: extraLists[i] })), { q: own, l: ownRes.l || [] }];
    const order = [chNewest, own, heNewest].filter(Boolean);
    const byQ = q => named.find(x => x.q === q)?.l || [];
    // A real channel found: its uploads alone, newest first, with paging.
    for (const q of order) {
      const l = byQ(q);
      if (l?.uploads && l.length) {
        const list = [...l];
        return meta(list, { pages: [{ playlistId: l.uploads.playlistId, token: l.uploads.token }], channel: l.uploads.channelTitle || null, query: q });
      }
    }
    if (ownRes.e && !extraLists.some(l => l.length)) throw ownRes.e;
    // No channel: the date-sorted searches, newest first.
    const seenN = new Set(), mergedN = [];
    for (const q of order) for (const v of byQ(q)) if (v && !seenN.has(v.videoId)) { seenN.add(v.videoId); mergedN.push(v); }
    mergedN.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
    return meta(mergedN, { pages: order.map(q => ({ query: q, token: byQ(q)?.nextPageToken || null, newest: true })) });
  }

  // Every planned search runs at once (Hebrew, the asked language, topics), each only once.
  const fx = plan?.en || null; // the search in English or in the asked language
  const extra = [...new Set([rewritten, fx, ...(plan?.topics || [])].filter(q => q && q !== own))];
  const [webList, ownRes, ...extraLists] = await Promise.all([
    hints?.videos?.length ? byIds(hints.videos.map(v => v.videoId), { apiKey, fetchImpl: opts.fetchImpl }).catch(() => []) : [],
    ownSearch,
    ...extra.map(q => search(q, (q === fx || (foreign && (plan?.topics || []).includes(q))) ? fxOpts : opts).catch(() => [])),
  ]);
  if (ownRes.e && !webList.length && !extraLists.some(l => l.length)) throw ownRes.e;
  const listOf = q => (q === own ? ownRes.l || [] : extraLists[extra.indexOf(q)] || []);
  // Order of the merge: a language asked -> its search leads; a topic asked
  // (or a request by style) -> the focused searches keep its conditions and
  // lead (live 13.11); otherwise web links, the Hebrew search, the caller's
  // own words, and the English search last.
  const order = foreign
    ? [fx, ...(plan?.topics || []), own, rewritten]
    : plan?.topics?.length ? [...plan.topics, rewritten, own, fx] : [rewritten, own, fx];
  const queries = [...new Set(order.filter(Boolean))];
  const lists = queries.map(listOf);
  const all = foreign ? [...lists, webList] : plan?.topics?.length ? [...lists, webList] : [webList, ...lists];
  const seen = new Set(), merged = [];
  const max = Math.max(0, ...all.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of all) { const v = l[i]; if (v && !seen.has(v.videoId)) { seen.add(v.videoId); merged.push(v); } }
  // Titles that sound like the request move up (live 12.11). Not for a topic
  // search (the subject is not a title) nor for another language.
  if (!plan?.topics?.length && !topic && !foreign) rankBySound(merged, [own, rewritten, hints?.corrected].filter(Boolean));
  // Another language asked: titles in its letters first (stable).
  const final = lang ? [...merged.filter(v => titleInLanguage(v.title, lang)), ...merged.filter(v => !titleInLanguage(v.title, lang))] : merged;
  const pages = queries.map(q => ({ query: q, token: listOf(q)?.nextPageToken || null, ...(foreign && (q === fx || q === own || (plan?.topics || []).includes(q)) ? { relevanceLanguage: foreign.code } : {}) }));
  return tag(final, { pages, rewritten, plan: plan ? { ...plan, english, lang: lang?.code || null, topic } : (lang || topic ? { lang: lang?.code || null, topic } : null), web: hints ? { provider: hints.provider, videos: webList.length, corrected: hints.corrected } : null, lang: lang?.code || null });
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
// A channel's uploads continue newest first, page after page (18.11).
export async function moreYouTubeResults(prev, opts = {}, search = searchYouTubeVideos, uploads = moreChannelUploads) {
  const pages = (prev?.pages || []).filter(p => p.token);
  if (!pages.length) return null;
  const lists = await Promise.all(pages.map(p => (p.playlistId
    ? uploads(p.playlistId, p.token, opts)
    : search(p.query, { ...opts, pageToken: p.token, ...(p.relevanceLanguage ? { relevanceLanguage: p.relevanceLanguage } : {}), ...(p.newest ? { newest: true } : {}) })).catch(() => [])));
  const seen = new Set(prev.map(v => v.videoId)), add = [];
  const max = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) { const v = l[i]; if (v && !seen.has(v.videoId)) { seen.add(v.videoId); add.push(v); } }
  if (pages.some(p => p.newest || p.playlistId)) add.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  const next = pages.map((p, i) => ({ ...p, token: lists[i]?.nextPageToken || null }));
  return { add, pages: next };
}
