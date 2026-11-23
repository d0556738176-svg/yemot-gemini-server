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
    'בפירוש על פסוק, תן גם את הפסוק עצמו. אם אינך יודע את המקום בוודאות, החזר רשימה ריקה.\nהשאלה: ' + String(question).slice(0, 400);
  let refs = [];
  try {
    const out = String(await llm(prompt, { planner: true, budgetMs: 5000, maxTokens: 300 }) || '');
    refs = (JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || '{}').refs || []).map(String).map(x => x.trim()).filter(x => x && x.length < 90).slice(0, maxRefs);
  } catch {}
  if (!refs.length) return null;
  const got = (await Promise.all(refs.map(ref => sefariaText(ref, { fetchImpl }).catch(() => null)))).filter(Boolean);
  log.info?.('[TORAH] Sefaria sources', { asked: refs.length, found: got.length });
  if (!got.length) return null;
  return { refs: got.map(g => g.ref), text: got.map(g => 'מקור: ' + (g.heRef || g.ref) + '\n' + g.text).join('\n\n') };
}
