function normalize(text) {
  return String(text || '')
    .normalize('NFKC').toLowerCase()
    .replace(/[.,!?;:״"'׳]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

const NUMBER_WORDS = new Map(Object.entries({
  'אחד':1,'אחת':1,'ראשון':1,'ראשונה':1,'הראשון':1,'הראשונה':1,
  'שתיים':2,'שניים':2,'שתי':2,'שני':2,'שניה':2,'שנייה':2,'השני':2,'השניה':2,'השנייה':2,
  'שלוש':3,'שלושה':3,'שלישי':3,'שלישית':3,'השלישי':3,'השלישית':3,
  'ארבע':4,'ארבעה':4,'רביעי':4,'רביעית':4,'הרביעי':4,'הרביעית':4,
  'חמש':5,'חמישה':5,'חמישי':5,'חמישית':5,'החמישי':5,'החמישית':5
}));

export function selectedResultIndex(text, results = []) {
  const value = normalize(text);
  if (!value || !Array.isArray(results) || !results.length) return -1;

  const digit = value.match(/(?:מספר|תוצאה)?\s*(\d{1,2})(?:\s|$)/u);
  if (digit) {
    const index = Number(digit[1]) - 1;
    return index >= 0 && index < results.length ? index : -1;
  }

  for (const [word, number] of NUMBER_WORDS) {
    if (new RegExp('(^|\\s)' + word + '($|\\s)', 'u').test(value)) {
      const index = number - 1;
      return index < results.length ? index : -1;
    }
  }

  // Natural speech may repeat a distinctive part of the title or channel.
  // Require at least two meaningful words to avoid accidental selection.
  const stop = new Set(['אני','רוצה','את','של','זה','הזה','תוצאה','סרטון','וידאו','לי','תשמיע','תפעיל','בבקשה']);
  const spoken = value.split(' ').filter(w => w.length >= 2 && !stop.has(w));
  if (spoken.length < 2) return -1;

  let best = { index: -1, score: 0 };
  results.forEach((result, index) => {
    const haystack = normalize((result?.title || '') + ' ' + (result?.channelTitle || ''));
    const score = spoken.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0);
    if (score > best.score) best = { index, score };
  });
  return best.score >= 2 ? best.index : -1;
}

export function isMoreResultsRequest(text) {
  return /(^|\s)(עוד|הבא|הבאה)(\s|$)|תוצאות נוספות|עוד תוצאות|דף הבא|תראה עוד|תביא עוד/u.test(normalize(text));
}

export function isFreshYouTubeSearch(text) {
  return /(^|\s)(חפש|תחפש|תמצא|תאתר|חיפוש)(\s|$)|נושא חדש|חיפוש חדש|משהו אחר/u.test(normalize(text));
}
