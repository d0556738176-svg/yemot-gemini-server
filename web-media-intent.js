// Extensions 1 and 3 (owner, 18.11): "search the whole web for a recording /
// video of ..." sends the caller to extension 2's deep web search (keys 5/6/3
// there), where he hears the results and confirms with a key before anything
// is downloaded. Returns the search words, or null.
import { isCapabilityQuestion } from './caller-intent.js';

const WEB = /(?:מהאינטרנט|מהרשת|בכל\s+(?:ה)?אתרים|בכל\s+(?:ה)?אינטרנט|באינטרנט|ברשת|באתרים|מכל\s+(?:ה)?אתרים|בכל\s+הרשת)/u;
const MEDIA = /(?:סרטון|סרטונים|הקלטה|הקלטות|שיעור|שיעורים|הרצאה|הרצאות|וידאו|וידיאו|קליפ|שיר|שירים|ניגון|דרשה|שיחה מוקלטת|קובץ שמע|אודיו)/u;
const SITE = /(?:(?:מ|ב|מה)אתר\s+[\u0590-\u05FFa-zA-Z0-9][\u0590-\u05FFa-zA-Z0-9.\-]+|[a-z0-9\-]+(?:\.|\s)(?:com|co\.il|co il|org|org il|net|tv|fm|io)\b|(?:מ|ב)(?:קול הלשון|דרשו|הידברות|ידברו|ערוץ מאיר|שופר|ספוטיפיי|סאונדקלאוד|סאונד קלאוד|פודקאסט|ויקיפדיה|מאיר טיוי|פייסבוק|טיקטוק|דיילימושן|וימאו))/iu;
const LIVE = /(?:ה?שידור ה?חי|ה?שידורים ה?חיים|בלייב|לייב)/u;
const ASK = /(?:לשמוע|להאזין|תפתח|תפתחי|לפתוח|תדליק|תדליקי|תעביר|תעבירי|תחפש|תחפשי|חפש|חפשי|לחפש|תמצא|תמצאי|מצא|מצאי|למצוא|תוריד|תורידי|להוריד|תביא|תביאי|רוצה|אני רוצה|תשמיע|תשמיעי)/u;
const LEAD = /^(?:(?:אני\s+)?רוצה\s+(?:ש)?|בבקשה\s+|תוכל\s+|תוכלי\s+|אפשר\s+)?(?:(?:לשמוע|להאזין ל?|תפתח|תפתחי|לפתוח|תדליק|תדליקי|תעביר|תעבירי|תחפש|תחפשי|חפש|חפשי|לחפש|תמצא|תמצאי|מצא|מצאי|למצוא|תוריד|תורידי|להוריד|תביא|תביאי|תשמיע|תשמיעי)\s+)?(?:לי\s+)?/u;

export function webSearchIntent(text) {
  const t = String(text || '').normalize('NFKC').replace(/[.,!?״"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || !ASK.test(t)) return null;
  // 19.11: "can you download from other sites?" is a question, not a search.
  if (isCapabilityQuestion(t)) return null;
  // A live broadcast (owner, 18.11) needs no "on the internet": the words
  // "שידור חי" stay in the search, so extension 2 looks for live ones.
  const live = LIVE.test(t);
  // Owner, 19.11: a named site ("מאתר קול הלשון", "מדרשו", "kolhalashon.com")
  // is a whole-web request too; the site's name stays in the search.
  const site = SITE.test(t);
  if (!live && (!(WEB.test(t) || site) || !MEDIA.test(t))) return null;
  let q = t.replace(new RegExp('\\s*' + WEB.source + '(?:\\s+(?:את|אחרי|עבור))?\\s*', 'u'), ' ').replace(/\s+/g, ' ').trim();
  q = q.replace(LEAD, '').replace(/^(?:את\s+)/u, '').trim();
  return q.length >= 2 ? q.slice(0, 200) : null;
}
