// Keep prior conversation available for genuine follow-ups, not as distracting context
// for every unrelated question. This helper is intentionally deterministic and testable.
export function selectRelevantHistoryForTurn(question, persistedHistoryText = '', currentTurnHistory = []) {
  const q = String(question || '').trim();
  if (!q) return '';

  // Callers naturally use short status checks after asking the system to look something up.
  // These must stay attached to the pending request ("נו, מצאת?", "הצלחת?", "מה עם זה?").
  const explicitFollowUp = /(?:נו[, ]*)?(?:מצאת|הצלחת|בדקת|חיפשת|מה יצא|מה התוצאה|מה עם זה|מה עם המספר|יש תשובה|יש עדכון|עדכון|תעדכן|תזכיר לי מה חיפשתי|מה בדיוק חיפשתי|תמשיך|המשך|תרחיב|תפרט|תסביר יותר|הפרט הראשון|הדבר הראשון|מה שאמרת|מה אמרת קודם|תמשיך מאיפה|מאיפה שעצרת|ומה לגבי|ומה עם|כמה זה עולה|מה המחיר|שלהם|שלהן|שלו|שלה|אותו|אותה|באתר הזה|בדף הזה|בעמוד הזה|תבדוק את זה|תנסה שוב|נסה שוב|תמשיך שוב|שמעת מה שאלתי|מה שאלתי אותך|זה לא מה ששאלתי|לא ענית(?: על השאלה)?|לא הבנת אותי|תענה על השאלה|תענה למה ששאלתי)/i.test(q);
  const shortReferential = q.length <= 90 && /^(?:אז\s*)?(?:נו[, ]*)?(?:כן[, ]*)?(?:מצאת|הצלחת|בדקת|חיפשת|מה יצא|מה התוצאה|ומה עם זה|מה עם המספר|יש תשובה|יש עדכון|למה|איך זה|מה לגבי|ומה עם|כמה זה|איפה זה|מתי זה|תבדוק|בדוק|תחפש|חפש|תמשיך|תרחיב|תפרט|תסביר|זה|אותו|אותה)\b/i.test(q);
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


// If the caller asks for a status update while a branch-1 lookup was left pending,
// rerun the original request instead of generating a generic reply that asks them to repeat it.
export function resolvePendingLookupQuestion(question, currentTurnHistory = [], isLookupRequest = () => false) {
  const q = String(question || '').trim();
  if (!/^(?:אז\s*)?(?:נו[, ]*)?(?:מצאת|הצלחת|בדקת|חיפשת|מה יצא|מה התוצאה|יש תשובה|יש עדכון|תעדכן|מה עם המספר|מה עם זה)[?!. ]*$/i.test(q)) return '';
  const previous = Array.isArray(currentTurnHistory) ? currentTurnHistory.at(-1) : null;
  if (!previous || !String(previous.user || '').trim() || !isLookupRequest(String(previous.user || ''))) return '';
  if (!/(בודק|בודקת|בודקים|אבדוק|מחפש|מחפשת|חיפשתי[, ]*אבל|מנסה לאתר|מיד בודק|צריך שתזכיר|תזכיר לי|לא הצלחתי כרגע)/i.test(String(previous.assistant || ''))) return '';
  return String(previous.user).trim();
}
