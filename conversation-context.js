// Keep prior conversation available for genuine follow-ups, not as distracting context
// for every unrelated question. This helper is intentionally deterministic and testable.
export function selectRelevantHistoryForTurn(question, persistedHistoryText = '', currentTurnHistory = []) {
  const q = String(question || '').trim();
  if (!q) return '';

  // Callers naturally use short status checks after asking the system to look something up.
  // These must stay attached to the pending request ("נו, מצאת?", "הצלחת?", "מה עם זה?").
  const explicitFollowUp = /(?:נו[, ]*)?(?:מצאת|הצלחת|בדקת|חיפשת|מה יצא|מה התוצאה|מה עם זה|מה עם המספר|יש תשובה|יש עדכון|עדכון|תעדכן|תזכיר לי מה חיפשתי|מה בדיוק חיפשתי|תמשיך|המשך|תרחיב|תפרט|תסביר יותר|הפרט הראשון|הדבר הראשון|מה שאמרת|מה אמרת קודם|תמשיך מאיפה|מאיפה שעצרת|ומה לגבי|ומה עם|כמה זה עולה|מה המחיר|שלהם|שלהן|שלו|שלה|אותו|אותה|באתר הזה|בדף הזה|בעמוד הזה|תבדוק את זה|תנסה שוב|נסה שוב|תמשיך שוב|שמעת מה שאלתי|מה שאלתי אותך|זה לא מה ששאלתי|לא ענית(?: על השאלה)?|לא הבנת אותי|תענה על השאלה|תענה למה ששאלתי)/i.test(q);
  const shortReferential = q.length <= 90 && /^(?:אז\s*)?(?:נו[, ]*)?(?:כן[, ]*)?(?:מצאת|הצלחת|בדקת|חיפשת|מה יצא|מה התוצאה|ומה עם זה|מה עם המספר|יש תשובה|יש עדכון|למה|איך זה|מה לגבי|ומה עם|כמה זה|איפה זה|מתי זה|תבדוק|בדוק|תחפש|חפש|תמשיך|תרחיב|תפרט|תסביר|זה|אותו|אותה)\b/i.test(q);
  // Natural follow-ups often omit the topic entirely and ask to reshape the
  // immediately previous answer ("give me three main advantages briefly",
  // "summarize it", "give examples", "explain the second one"). Treat these as
  // contextual only when there is current-call history, so old calls cannot leak
  // into a genuinely new topic.
  const answerTransformationFollowUp = Array.isArray(currentTurnHistory) && currentTurnHistory.length > 0 &&
    q.length <= 180 &&
    /(?:^|\s)(?:תן לי|תביא לי|תציג|תמנה|מנה|סכם|תסכם|תקצר|בקצרה|בכמה מילים|נקודות|יתרונות|חסרונות|דוגמאות|דוגמה|הראשון|השני|השלישי|האחרון|עיקרי|עיקריים|מרכזי|מרכזיים)(?:\s|$)/i.test(q);

  const current = Array.isArray(currentTurnHistory) ? currentTurnHistory.slice(-4) : [];
  const currentText = current.map((t, i) =>
    'תור ' + (i + 1) + ' — מתקשר: ' + String(t.user || '') +
    '\nתשובה: ' + String(t.assistant || '')
  ).join('\n\n');
  const persisted = String(persistedHistoryText || '').trim();

  // Keep durable memory available for genuine follow-ups, but do not inject
  // unrelated old calls into every new question. Within a live call, the
  // immediately relevant turns take precedence over persisted history.
  // Questions about earlier conversations or about the caller himself ("על מה
  // דיברנו בפעם הקודמת", "אתה זוכר מה שאלתי", "מה השם שלי") need the saved
  // memory of previous calls together with the current call.
  const memoryRecall = isMemoryRecall(q);
  if (memoryRecall) return [persisted, currentText].filter(Boolean).join('\n\n');
  if (answerTransformationFollowUp) return currentText;
  if (explicitFollowUp || shortReferential) {
    // Transformation-style requests such as "give me three advantages briefly"
    // are only meaningful against the immediately preceding turn. Never bind them
    // to an older persisted call when the current call has no prior turn.
    const transformationWithoutCurrent = !currentText &&
      /(?:^|\s)(?:תן לי|תביא לי|תציג|תמנה|מנה|סכם|תסכם|תקצר|בקצרה|בכמה מילים|נקודות|יתרונות|חסרונות|דוגמאות|דוגמה|עיקרי|עיקריים|מרכזי|מרכזיים)(?:\s|$)/i.test(q) &&
      !/(?:תמשיך|המשך|תרחיב|תפרט|תסביר יותר|הפרט הראשון|הדבר הראשון|מה שאמרת|מה אמרת קודם|תמשיך מאיפה|מאיפה שעצרת)/i.test(q);
    if (transformationWithoutCurrent) return '';
    if (currentText) return currentText;
    return persisted;
  }
  return '';
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

// Questions about earlier calls or about the caller himself.
export function isMemoryRecall(question) {
  return /(?:זוכר|תזכור|זכרת|נזכר|דיברנו|שוחחנו|בשיחה הקודמת|בשיחה האחרונה|בפעם הקודמת|בפעם שעברה|פעם קודמת|בפעם האחרונה|אתמול|שלשום|לפני כמה ימים|מה שאלתי|על מה שאלתי|שאלתי אותך|סיפרתי לך|אמרתי לך|ביקשתי ממך|השם שלי|איך קוראים לי|איפה אני גר|במה אני עובד|מה אני אוהב|מה אתה יודע עליי|מה אתה יודע עלי|מה אתה זוכר)/i.test(String(question || ''));
}
