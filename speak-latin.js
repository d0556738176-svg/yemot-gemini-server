// Owner, 25.11: Yemot's Hebrew voice skips English letters. A channel called
// "C14" was heard as nothing, and "i24NEWS עברית" as just "עברית". Every
// English part of a spoken name is turned into Hebrew letters as it is said:
//   known names    i24NEWS -> איי 24 ניוז, C14 -> סי 14, CNN -> סי אן אן
//   abbreviations  (capitals, or letters with digits) letter by letter
//   other words    Hebrew transliteration (Groq, kept in memory), else
//                  letter by letter, so nothing is ever silently dropped.
const LETTERS = { a: 'איי', b: 'בי', c: 'סי', d: 'די', e: 'אי', f: 'אף', g: "ג'י", h: "אייץ'", i: 'איי', j: "ג'יי", k: 'קיי', l: 'אל', m: 'אם', n: 'אן', o: 'או', p: 'פי', q: 'קיו', r: 'אר', s: 'אס', t: 'טי', u: 'יו', v: 'וי', w: 'דאבל יו', x: 'אקס', y: 'וואי', z: 'זי' };
const KNOWN = { news: 'ניוז', tv: 'טי וי', live: 'לייב', official: 'אופישל', channel: "צ'אנל", radio: 'רדיו', music: 'מיוזיק', the: 'דה', and: 'אנד', of: 'אוף', israel: 'ישראל', jewish: "ג'ואיש", torah: 'תורה', rabbi: 'רבי', media: 'מדיה', studio: 'סטודיו', show: 'שואו', podcast: 'פודקאסט', ai: 'איי איי', i24news: 'איי 24 ניוז', c14: 'סי 14', now: 'נאו', kan: 'כאן', reshet: 'רשת', keshet: 'קשת', mako: 'מאקו', ynet: 'וויינט', walla: 'וואלה', knesset: 'כנסת', kikar: 'כיכר', hashabat: 'השבת', hidabroot: 'הידברות', youtube: 'יוטיוב', vlog: 'וולוג' };
const cache = new Map();
const LATIN = /[A-Za-z]/;
export const hasLatin = t => LATIN.test(String(t || ''));
const spell = w => w.split('').map(ch => LETTERS[ch.toLowerCase()] || ch).join(' ');

// One English token (letters, maybe with digits) -> Hebrew, or null when only
// a transliteration engine can do it well.
export function tokenToHebrew(tok) {
  const low = tok.toLowerCase();
  if (KNOWN[low]) return KNOWN[low];
  // i24NEWS-like: split letters and digits and say each part.
  if (/\d/.test(tok)) return tok.split(/(\d+)/).filter(Boolean).map(p => /^\d+$/.test(p) ? p : (KNOWN[p.toLowerCase()] || (p.length <= 4 || p === p.toUpperCase() ? spell(p) : null) || spell(p))).join(' ');
  if (tok.length <= 4 && tok === tok.toUpperCase()) return spell(tok); // CNN, BBC, IDF
  if (tok.length === 1) return spell(tok);
  return null;
}

export async function speakable(text, { translit } = {}) {
  const s = String(text || '');
  if (!hasLatin(s)) return s;
  if (cache.has(s)) return cache.get(s);
  const tokens = [...new Set(s.match(/[A-Za-z][A-Za-z0-9']*|\d+[A-Za-z][A-Za-z0-9']*/g) || [])];
  const map = {};
  const rest = [];
  for (const t of tokens) { const h = tokenToHebrew(t); if (h) map[t] = h; else rest.push(t); }
  if (rest.length && translit) {
    const got = await translit(rest).catch(() => null);
    for (const t of rest) if (got?.[t] && /[א-ת]/.test(got[t]) && !/[A-Za-z]/.test(got[t])) map[t] = got[t];
  }
  for (const t of rest) map[t] ||= spell(t);
  const out = s.replace(/[A-Za-z][A-Za-z0-9']*|\d+[A-Za-z][A-Za-z0-9']*/g, m => map[m] || m).replace(/\s+/g, ' ').trim();
  cache.set(s, out); if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return out;
}

// Groq: transliteration (sound, not translation) of a few English words.
export async function groqTranslit(words, { timeoutMs = 3500 } = {}) {
  const { groqChat } = await import('./groq-chat.js');
  const t = await groqChat([
    { role: 'system', content: 'Transliterate each English word into Hebrew letters as an Israeli would pronounce it (sound, NOT translation). Brand and person names as they are said in Israel. Return JSON only: {"word":"hebrew", ...}' },
    { role: 'user', content: JSON.stringify(words) },
  ], { maxTokens: 60 + words.length * 20, timeoutMs });
  const m = /\{[\s\S]*\}/.exec(String(t || ''));
  return m ? JSON.parse(m[0]) : null;
}
