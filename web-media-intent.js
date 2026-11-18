// Extensions 1 and 3 (owner, 18.11): "search the whole web for a recording /
// video of ..." sends the caller to extension 2's deep web search (keys 5/6/3
// there), where he hears the results and confirms with a key before anything
// is downloaded. Returns the search words, or null.
const WEB = /(?:מהאינטרנט|מהרשת|בכל\s+(?:ה)?אתרים|בכל\s+(?:ה)?אינטרנט|באינטרנט|ברשת|באתרים|מכל\s+(?:ה)?אתרים|בכל\s+הרשת)/u;
const MEDIA = /(?:סרטון|סרטונים|הקלטה|הקלטות|שיעור|שיעורים|הרצאה|הרצאות|וידאו|וידיאו|קליפ|שיר|שירים|ניגון|דרשה|שיחה מוקלטת|קובץ שמע|אודיו)/u;
const ASK = /(?:תחפש|תחפשי|חפש|חפשי|לחפש|תמצא|תמצאי|מצא|מצאי|למצוא|תוריד|תורידי|להוריד|תביא|תביאי|רוצה|אני רוצה|תשמיע|תשמיעי)/u;
const LEAD = /^(?:(?:אני\s+)?רוצה\s+(?:ש)?|בבקשה\s+|תוכל\s+|תוכלי\s+|אפשר\s+)?(?:(?:תחפש|תחפשי|חפש|חפשי|לחפש|תמצא|תמצאי|מצא|מצאי|למצוא|תוריד|תורידי|להוריד|תביא|תביאי|תשמיע|תשמיעי)\s+)?(?:לי\s+)?/u;

export function webSearchIntent(text) {
  const t = String(text || '').normalize('NFKC').replace(/[.,!?״"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || !WEB.test(t) || !MEDIA.test(t) || !ASK.test(t)) return null;
  let q = t.replace(new RegExp('\\s*' + WEB.source + '(?:\\s+(?:את|אחרי|עבור))?\\s*', 'u'), ' ').replace(/\s+/g, ' ').trim();
  q = q.replace(LEAD, '').replace(/^(?:את\s+)/u, '').trim();
  return q.length >= 2 ? q.slice(0, 200) : null;
}
