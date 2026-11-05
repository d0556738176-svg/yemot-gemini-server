import { groqChat } from './groq-chat.js';
// File names for the download folders (אודיו / וידאו).
//
// Measured 05.11: when a file is downloaded from Yemot, Yemot's server sends
// its name with every Hebrew letter replaced by a space
// ("attachment; filename=    _       _     _     _Motty_Steinmetz_..."), so
// a Hebrew file name arrives as "_ _ _". Latin letters arrive intact. The
// files are therefore named with the title written in English letters; the
// full Hebrew title stays inside the file (metadata), which players show.

const MAP = {
  'א': 'a', 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'o', 'ז': 'z', 'ח': 'ch', 'ט': 't', 'י': 'i',
  'כ': 'ch', 'ך': 'ch', 'ל': 'l', 'מ': 'm', 'ם': 'm', 'נ': 'n', 'ן': 'n', 'ס': 's', 'ע': 'a', 'פ': 'f',
  'ף': 'f', 'צ': 'tz', 'ץ': 'tz', 'ק': 'k', 'ר': 'r', 'ש': 'sh', 'ת': 't',
};

// Letter-by-letter fallback (no vowels in Hebrew text, so it is approximate).
export function hebrewToLatin(text) {
  return String(text || '').replace(/[א-ת]+/g, word => {
    let out = '';
    [...word].forEach((ch, i) => {
      const first = i === 0, last = i === word.length - 1;
      if (ch === 'ו') out += first ? 'v' : 'o';
      else if (ch === 'י') out += first ? 'y' : 'i';
      else if (ch === 'ב') out += first ? 'b' : 'v';
      else if (ch === 'פ') out += first ? 'p' : 'f';
      else if (ch === 'כ') out += first ? 'k' : 'ch';
      else if (ch === 'ה' && last) out += 'a';
      else if (ch === 'א' && last) out += 'a';
      else out += MAP[ch] || '';
    });
    return out.charAt(0).toUpperCase() + out.slice(1);
  }).replace(/[֑-ׇ]/g, '');
}

// Safe Latin file name (letters, digits, underscore), at most `max` chars.
export function latinFileName(text, max = 90) {
  const s = String(text || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  return s.slice(0, max).replace(/_+$/, '');
}

// Asks a fast language model for a natural English-letter spelling of the
// title (e.g. "הנשמה בקרבי" -> "Haneshama Bekirbi"); falls back to the
// letter-by-letter version. Never throws.
export async function latinTitle(title, env = process.env, fetchImpl = fetch) {
  const t = String(title || '').trim();
  if (!t) return '';
  if (!/[א-ת]/.test(t)) return t;
  const out = String(await groqChat([
    { role: 'system', content: 'You transliterate Hebrew titles into English letters the way Israelis spell them in English (for example "הנשמה בקרבי" -> "Haneshama Bekirbi", "מרדכי בן דוד" -> "Mordechai Ben David"). Keep words that are already in English. Output only the transliterated title, nothing else.' },
    { role: 'user', content: t }], { env, fetchImpl, maxTokens: 120, timeoutMs: Number(env.LATIN_TITLE_TIMEOUT_MS || 8000) }) || '').split('\n')[0].replace(/^["'*]+|["'*]+$/g, '').trim();
  if (out && !/[א-ת]/.test(out) && latinFileName(out).length >= 3) return out;
  return hebrewToLatin(t);
}
