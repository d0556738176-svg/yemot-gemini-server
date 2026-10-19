// Keep prior conversation available for genuine follow-ups, not as distracting context
// for every unrelated question. This helper is intentionally deterministic and testable.
export function selectRelevantHistoryForTurn(question, persistedHistoryText = '', currentTurnHistory = []) {
  const q = String(question || '').trim();
  if (!q) return '';

  const explicitFollowUp = /(?:תמשיך|המשך|תרחיב|תפרט|תסביר יותר|הפרט הראשון|הדבר הראשון|מה שאמרת|מה אמרת קודם|תמשיך מאיפה|מאיפה שעצרת|ומה לגבי|ומה עם|כמה זה עולה|מה המחיר|שלהם|שלהן|שלו|שלה|אותו|אותה|שם|באתר הזה|בדף הזה|בעמוד הזה|תבדוק את זה|תנסה שוב|נסה שוב|תמשיך שוב)/i.test(q);
  const shortReferential = q.length <= 70 && /^(?:אז\s*)?(?:כן[, ]*)?(?:למה|איך זה|מה לגבי|ומה עם|כמה זה|איפה זה|מתי זה|תבדוק|בדוק|תחפש|חפש|תמשיך|תרחיב|תפרט|תסביר|זה|אותו|אותה)\b/i.test(q);
  if (!explicitFollowUp && !shortReferential) return '';

  const current = Array.isArray(currentTurnHistory) ? currentTurnHistory.slice(-4) : [];
  if (current.length) {
    return current.map((t, i) =>
      'תור ' + (i + 1) + ' — מתקשר: ' + String(t.user || '') +
      '\nתשובה: ' + String(t.assistant || '')
    ).join('\n\n');
  }
  return String(persistedHistoryText || '').trim();
}
