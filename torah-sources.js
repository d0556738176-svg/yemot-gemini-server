// Owner, 24.11: answers on Torah texts must be true. A question about a verse,
// Rashi, the Gemara, the Mishnah, the Rambam, the Shulchan Aruch and so on
// gets the real text from Sefaria (free, no key) before the answer is written;
// the model only explains what the text says. No text found = no source given.
const TORAH_WORDS = ['רש["״׳\']?י', 'רמב["״׳\']?ם', 'רמב["״׳\']?ן', 'תוספות', 'גמרא', 'גמ[\'׳]', 'תלמוד', 'ירושלמי', 'בבלי', 'משנה', 'משנה ברורה', 'מסכת', 'פסוק', 'פסוקים', 'פרשת', 'פרשה', 'תהילים', 'תהלים', 'שולחן ערוך', 'שו["״]ע', 'מדרש', 'אבן עזרא', 'ספורנו', 'אור החיים', 'כלי יקר', 'בעל הטורים', 'אונקלוס', 'פרקי אבות', 'תנ["״]ך', 'ישעיה', 'ירמיה', 'יחזקאל', 'משלי', 'קהלת', 'איוב', 'דניאל', 'שיר השירים', 'מגילת אסתר', 'מגילת רות', 'הלכות', 'מראה מקום', 'איפה כתוב', 'מה כתוב', 'מה המקור', 'המקור ל'];
// Whole words only (with a Hebrew prefix letter): "פריסה" is not "רות".
export const TORAH_Q = new RegExp('(?:^|[^\\u0590-\\u05FF])(?:[ובהמלשכ]{0,2})(?:' + TORAH_WORDS.join('|') + ')(?=$|[^\\u0590-\\u05FF])', 'u');
export const isTorahQuestion = t => TORAH_Q.test(String(t || ''));

const strip = x => String(x || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const flat = x => Array.isArray(x) ? x.flatMap(flat) : [strip(x)].filter(Boolean);

export async function sefariaText(ref, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const u = 'https://www.sefaria.org/api/v3/texts/' + encodeURIComponent(ref) + '?version=hebrew&return_format=text_only';
  const r = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const v = (j?.versions || []).find(x => x?.text && flat(x.text).length) || null;
  const text = v ? flat(v.text).join(' ') : '';
  if (!text) return null;
  return { ref: j.ref || ref, heRef: j.heRef || '', text: text.slice(0, 3500) };
}

// The places to read, from a fast model; nothing invented is kept, because a
// place Sefaria does not know returns no text.
export async function torahSources(question, { llm, fetchImpl = fetch, log = console, maxRefs = 3 } = {}) {
  if (!llm) return null;
  const prompt = 'השאלה הבאה עוסקת בטקסט תורני. החזר JSON בלבד: {"refs":["..."]} - עד ' + maxRefs + ' מראי מקום מדויקים בפורמט של אתר ספריא באנגלית, שבהם כתוב בדיוק מה שהשואל מבקש. ' +
    'דוגמאות לפורמט: "Genesis 1:1", "Rashi on Genesis 1:1", "Ramban on Exodus 12:2", "Berakhot 2a", "Mishnah Berakhot 1:1", "Pirkei Avot 1:1", "Mishneh Torah, Repentance 3:4", "Shulchan Arukh, Orach Chayim 1:1", "Mishnah Berurah 1:1", "Psalms 23", "Onkelos Genesis 1:1". ' +
    'בפירוש על פסוק, תן גם את הפסוק עצמו. אם אינך יודע את המקום בוודאות, החזר רשימה ריקה. ' +
    'בנוסף, כשהשאלה היא "מה כתוב ב... על נושא" או שאינך בטוח במקום, מלא גם "book" (שם הספר באנגלית כמו בספריא, למשל Pirkei Avot, Mishneh Torah, Proverbs, Berakhot) ו-"words" (מילה או שתיים בעברית לחיפוש בתוך הספר, למשל שתיקה). ' +
    'הפורמט: {"refs":[],"book":"","words":""}\nהשאלה: ' + String(question).slice(0, 400);
  let refs = [], book = '', words = '';
  try {
    const out = String(await llm(prompt, { planner: true, budgetMs: 5000, maxTokens: 300 }) || '');
    const j = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || '{}');
    refs = (j.refs || []).map(String).map(x => x.trim()).filter(x => x && x.length < 90).slice(0, maxRefs);
    book = String(j.book || '').trim().slice(0, 60); words = String(j.words || '').trim().slice(0, 40);
  } catch {}
  if (!refs.length && !(book && words)) return null;
  const [byRef, bySearch] = await Promise.all([
    Promise.all(refs.map(ref => sefariaText(ref, { fetchImpl }).catch(() => null))),
    book && words ? sefariaSearch(book, words, { fetchImpl }).catch(() => []) : Promise.resolve([]),
  ]);
  const got = [...byRef.filter(Boolean), ...bySearch].filter((g, i, a) => a.findIndex(x => x.ref === g.ref) === i).slice(0, 5);
  log.info?.('[TORAH] Sefaria sources', { asked: refs.length, found: got.length });
  if (!got.length) return null;
  return { refs: got.map(g => g.ref), text: got.map(g => 'מקור: ' + (g.heRef || g.ref) + '\n' + g.text).join('\n\n') };
}

// "What does Avot say about silence": Sefaria's own search inside that book.
export async function sefariaSearch(book, words, { fetchImpl = fetch, timeoutMs = 5000, size = 4 } = {}) {
  const idx = await fetchImpl('https://www.sefaria.org/api/v2/raw/index/' + encodeURIComponent(book), { signal: AbortSignal.timeout(timeoutMs) }).then(r => r.ok ? r.json() : null).catch(() => null);
  const path = idx?.categories?.length && idx?.title ? [...idx.categories, idx.title].join('/') : '';
  const body = { query: words, type: 'text', field: 'naive_lemmatizer', size, source_proj: true, slop: 10, ...(path ? { filters: [path], filter_fields: ['path'] } : {}) };
  const r = await fetchImpl('https://www.sefaria.org/api/search-wrapper', { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  const seen = new Set();
  return (j?.hits?.hits || []).map(h => h._source).filter(x => x?.ref && !seen.has(x.ref) && seen.add(x.ref))
    .map(x => ({ ref: x.ref, heRef: x.heRef || '', text: strip(x.exact || x.naive_lemmatizer || '').slice(0, 1500) })).filter(x => x.text);
}
