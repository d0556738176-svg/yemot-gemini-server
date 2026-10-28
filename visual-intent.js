// Conservative intent detection for branch 1 phone turns.
// Ambiguous verbs such as "תראה לי" and "תמחיש" alone must not start image analysis.
export function isMultimodalAnalysisRequest(text) {
  const q = String(text || '').toLowerCase();
  const imageNoun = /תמונה|תמונות|צילום(?: מסך)?|תצלום|תיאור חזותי|תיאור הפיזי/i.test(q);
  const clearVisualQuestion = /(?:מה רואים.{0,20}(?:בתמונה|בצילום|בסרטון|בווידאו)|איך (?:הוא נראה|היא נראית)|מה מופיע בתמונה|מה יש בתמונה|תאר(?: לי)? את התמונה|נתח(?: לי)? את התמונה)/i.test(q);
  const imageAction = /תמצא|מצא|חפש|תחפש|תראה|תביא|שלח|תציג|נתח|תנתח|תאר|תתאר|תסביר|הסבר/i.test(q);
  const negatedImageRequest = /(?:לא|בלי|אל ת|אין צורך ב|לא צריך(?:ה)?)\s*.{0,24}(?:תמונה|תמונות|צילום|תצלום|המחשה)/i.test(q);
  const asksVisual = !negatedImageRequest && (clearVisualQuestion || (imageNoun && imageAction));

  const videoNoun = /סרטון|סירטון|וידאו|קליפ|הסרטון הזה|הסרט הזה/i.test(q);
  const videoAction = /נתח|תנתח|תיאור|תאר|תתאר|מה רואים|מה שומעים|מה קורה|מה מופיע|מה הוא עושה|מה היא עושה|סכם|סיכום|תספר/i.test(q);
  const asksVideo = videoNoun && videoAction;
  const asksSite = /(?:תנתח|נתח|תסביר|הסבר|מה יש|מה כתוב|תיאור).{0,35}אתר/i.test(q);

  return {
    image: asksVisual && !asksVideo,
    video: asksVideo,
    site: asksSite,
    any: asksVisual || asksVideo || asksSite
  };
}

export function isVisualContinuationRequest(text, historyText = '') {
  const q = String(text || '').trim();
  const continuation = /^(?:אז\s*)?(?:תמצא|תמצאי|מצא|חפש|תחפש|מחפש|מחפשת|נסה שוב|תנסה שוב|תנסי שוב|שוב|תראה לי אותו|תראי לי אותו|איך הוא נראה|איך היא נראית|תיאור חזותי|תיאור הפיזי)[.!? ]*$/i.test(q);
  if (!continuation) return false;

  // Only the immediately preceding turn supplied by the caller is eligible.
  // A visual request from an older call/topic must not contaminate this turn.
  const turns = String(historyText || '').split(/\n\s*\n/).filter(Boolean);
  const lastTurn = turns.at(-1) || '';
  const userMatch = lastTurn.match(/מתקשר:\s*([^\n]+)/i);
  const previousUserText = String(userMatch?.[1] || '').trim();
  const previousIntent = isMultimodalAnalysisRequest(previousUserText);
  return previousIntent.image || previousIntent.video;
}

// An explicit ordinal wins over the previously pinned video. Never silently
// substitute result one when the caller selected an unavailable result.
export function selectReferencedVideo(question, context = {}) {
  const ordinals={הראשון:1,ראשון:1,הראשונה:1,ראשונה:1,השני:2,שני:2,השנייה:2,שנייה:2,השלישי:3,שלישי:3,השלישית:3,שלישית:3,הרביעי:4,רביעי:4,החמישי:5,חמישי:5};
  const match=String(question||'').match(/(?:סרטון|סירטון|תוצאה)\s*(?:מספר\s*)?(\d{1,2}|הראשון|ראשון|הראשונה|ראשונה|השני|שני|השנייה|שנייה|השלישי|שלישי|השלישית|שלישית|הרביעי|רביעי|החמישי|חמישי)(?=\s|[?!.,]|$)/u);
  if(match) return context.youtubeResults?.[(Number(match[1])||ordinals[match[1]])-1] || null;
  return context.currentVideo || context.youtubeResults?.[0] || null;
}

