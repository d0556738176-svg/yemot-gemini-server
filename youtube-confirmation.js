/**
 * Normalize short spoken answers used by the YouTube confirmation prompt.
 * Speech recognition may include punctuation or omit some opening words.
 */
function normalizeConfirmation(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[.,!?;:״"'׳]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const YES_EXACT = new Set([
  'כן', 'כן כן', 'כן בהחלט', 'בהחלט', 'בוודאי', 'בטח', 'ברור',
  'אני רוצה', 'רוצה', 'כן אני רוצה', 'כן אני רוצה לשמוע',
  'אני רוצה לשמוע את זה', 'אני רוצה לשמוע את הסרטון',
  'רוצה לשמוע את זה', 'רוצה לשמוע את הסרטון',
  'כן אני רוצה לשמוע את זה', 'כן אני רוצה לשמוע את הסרטון',
  'תשמיע', 'תשמיע לי', 'להשמיע', 'כן תשמיע', 'כן תשמיע לי',
  'כן תשמיע את השיר', 'כן תשמיע את הסרטון',
  'תשמיע לי את זה', 'תשמיע לי את הסרטון', 'תשמיע את זה',
  'תשמיע את הסרטון', 'תפעיל', 'תפעיל את הסרטון',
  'כן תפעיל', 'אפשר', 'אפשר לשמוע'
]);

const NO_EXACT = new Set([
  'לא', 'לא לא', 'לא תודה', 'לא רוצה', 'לא מעוניין', 'לא מעוניינת',
  'סיימתי', 'זה מספיק', 'תודה'
]);

const NEW_SEARCH_RE = /(^| )(חיפוש|חפש|תחפש|תמצא|תאתר|נושא חדש|משהו אחר)( |$)/u;

export function isYouTubeConfirmationYes(text) {
  const value = normalizeConfirmation(text);
  if (!value || NO_EXACT.has(value) || /(^| )לא( |$)/u.test(value)) return false;
  if (NEW_SEARCH_RE.test(value)) return false;
  if (YES_EXACT.has(value)) return true;

  // Accept common speech-to-text variants where "כן" was omitted.
  if (/^(אני רוצה|רוצה) לשמוע( |$)/u.test(value)) return true;
  if (/^(תשמיע|להשמיע|השמע|תפעיל)( |$)/u.test(value)) return true;
  if (/^אפשר לשמוע( |$)/u.test(value)) return true;

  // A clear "yes" followed by ordinary words is affirmative, unless it is a
  // request to search for something else.
  return /^כן( |$)/u.test(value);
}

export function isYouTubeConfirmationNo(text) {
  const value = normalizeConfirmation(text);
  if (!value || /(^| )כן( |$)/u.test(value)) return false;
  if (NO_EXACT.has(value)) return true;
  return /(^| )לא( |$)/u.test(value) &&
    !/(^| )(כן|בעצם כן)( |$)/u.test(value);
}
