/**
 * Normalize short spoken answers used by the YouTube confirmation prompt.
 * Yemot transcripts may include punctuation or extra words after "כן"/"לא".
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
  'תשמיע', 'תשמיע לי', 'להשמיע', 'כן תשמיע', 'כן תשמיע לי',
  'כן תשמיע את השיר', 'כן תשמיע את הסרטון', 'אפשר', 'אפשר לשמוע'
]);

const NO_EXACT = new Set([
  'לא', 'לא לא', 'לא תודה', 'לא רוצה', 'לא מעוניין', 'לא מעוניינת',
  'סיימתי', 'זה מספיק', 'תודה'
]);

export function isYouTubeConfirmationYes(text) {
  const value = normalizeConfirmation(text);
  if (!value || NO_EXACT.has(value) || /(^| )לא( |$)/u.test(value)) return false;
  if (YES_EXACT.has(value)) return true;
  // Accept a clear affirmative followed by natural speech, but do not treat
  // "כן, חיפוש חדש" or "כן, משהו אחר" as playback approval.
  if (value.startsWith('כן ') &&
      !/(^| )(חיפוש|חפש|תחפש|משהו אחר|לא)( |$)/u.test(value)) return true;
  return false;
}

export function isYouTubeConfirmationNo(text) {
  const value = normalizeConfirmation(text);
  if (!value || YES_EXACT.has(value) || /(^| )כן( |$)/u.test(value)) return false;
  if (NO_EXACT.has(value)) return true;
  return value.startsWith('לא ') && !/(^| )(כן|בעצם כן)( |$)/u.test(value);
}
