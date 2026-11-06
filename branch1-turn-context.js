// Current-call intent and references. Never infer a new task from cached results.
export function isConversationalReference(text) {
  const q=String(text||'').trim();
  return /^(?:כן|לא|נכון|בדיוק|בוודאי|בטח|עוד)[,.!? ]*$/u.test(q) ||
    /(?:^|\s)(?:הוא|היא|הם|הן|זה|זאת|שם|שמה|מזה|לזה|בזה|מול זה|לגבי|שלו|שלה|שלהם|אותו|אותה|אותם)(?:\s|[,.!?]|$)/u.test(q) ||
    /אמרת|שאלתי|לפני כן|קודם|תמשיך|תפרט|תרחיב|תסביר|תמצא לי בכל אופן|מצאת משהו/u.test(q);
}

export function currentConversationText(history=[]) {
  return history.slice(-8).map((t,i)=>'תור '+(i+1)+' — מתקשר: '+String(t.user||'').slice(0,800)+
    (t.resolvedQuestion&&t.resolvedQuestion!==t.user?'\nנושא הבקשה: '+String(t.resolvedQuestion).slice(0,1000):'')+
    '\nתשובה: '+String(t.assistant||'').slice(0,2400)).join('\n\n');
}

// Only subject-free search commands inherit a search target. New named requests
// and technical discussion stay exactly as spoken, with context passed separately.
export function resolveLookupContinuation(text, history=[], isLookup=()=>false) {
  const q=String(text||'').trim();
  const generic=/^(?:(?:אז|נו|כן|בבקשה)[, ]*)?(?:תמצא לי בכל אופן|תמצא לי|תחפש(?: לי)?|חפש(?: לי)?|תבדוק(?: לי)?|בדוק(?: לי)?|מצאת(?: משהו)?|הצלחת|יש עדכון|תנסה שוב|נסה שוב)[?.! ]*$/u.test(q);
  const referringSearch=/^(?:על|לגבי) מה שאמרת (?:לפני כן|קודם).{0,35}(?:תחפש|תמצא|תבדוק)(?: להיום| היום| למחר| מחר)?[?.! ]*$/u.test(q);
  if(!generic&&!referringSearch)return q;
  const last=history.at(-1);
  const anchor=String(last?.resolvedQuestion||last?.user||'').trim();
  if(!anchor||anchor===q||!isLookup(anchor))return q;
  const date=q.match(/להיום|היום|למחר|מחר/u)?.[0];
  const subject=date?anchor.replace(/מחרתיים|להיום|למחר|היום|מחר|הערב|השבוע/gu,'').trim():anchor;
  return subject.replace(/[?.!]+$/u,'')+'. '+q;
}

export function rejectsMediaSearch(text) {
  return /לא (?:רוצה )?(?:ש)?(?:תמצא|תחפש|חפש|תביא).{0,35}(?:תוצאות|סרטונים|ביוטיוב|שם|שמה)/u.test(String(text||''));
}

export function isYouTubeTechnicalDiscussion(text) {
  const q=String(text||'');
  return rejectsMediaSearch(q) ||
    /(?:איך|למה|בעיה|תקלה|שגיאה|נתקל|לעזור|תעזור|להתמודד|חסימ|חסיפ).{0,65}(?:הורד|מוריד|להוריד|שרת|חסימ|חסיפ|קוקי|cookie|yt-dlp)/iu.test(q) ||
    /(?:הורד|מוריד|להוריד|שרת|yt-dlp).{0,65}(?:חסימ|חסיפ|תקלה|בעיה|שגיאה|נתקל)/iu.test(q);
}

export function mayUseYouTubeSearch(text, context={}) {
  const q=String(text||'').trim();
  if(isYouTubeTechnicalDiscussion(q))return false;
  if(/youtube|יוטיוב|ביויוטב|ביוטוב/iu.test(q))return true;
  if(context.lastRoute!=='youtube')return false;
  // Follow-ups about the video just found stay with that video: what was said,
  // word for word, step by step, and what is seen in it.
  return /(?:תוצאה|סרטון|בדיחה)\s*(?:מספר\s*)?(?:[1-9]|ראשו|שני|שליש|רביע|חמיש)|הראשו|השני|השליש|כמה צפיות|כמה לייקים|שם הערוץ|מתי פורסם|תוכן הסרטון|סכם|תסכם|תמשיך|בסרטון|הסרטון|בסירטון|הסירטון|בוידאו|הוידאו|מה (?:הוא|היא|הם) (?:אמר|אמרה|אמרו|אומר|אומרת|אומרים)|מה נאמר|בדיוק|מילה במילה|שלב אחרי שלב|תמליל|תצטט|ציטוט|על מה|תמחיש|המחשה|מה רואים|איך (?:הוא|היא) נראה|תגובות/u.test(q);
}

export function asksForFeedback(answer) {
  return /(?:האם זה עזר|זה עזר לך|התשובה עזרה|האם עזרתי)[?.! ]*$/u.test(String(answer||'').trim());
}
