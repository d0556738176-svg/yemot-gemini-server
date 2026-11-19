// Extension 3 "brain" (owner, 10.11.2026).
//
// What went wrong before, from the call logs of 09-10.11:
//  * Any sentence with the word "יוטיוב" was routed to a raw search that read
//    "תוצאה 1, תוצאה 2 ..." like a robot, including vulgar titles.
//  * Asked for a recommended video, the model INVENTED a title, a channel
//    ("True Crime Mysteries") and a length; the caller searched for an hour.
//  * Memory questions failed: the whole 70-turn memory was pasted into the
//    prompt, the fast model refused it (HTTP 413) and the caller heard
//    "מנוע התשובות אינו זמין".
//  * "Yes" / "continue" after an offer (a lesson, "want me to explain?") was
//    not understood as continuing.
//
// The fix is one clear turn pipeline instead of dozens of keyword rules:
//  1. a compact, size-bounded context (summary + recent turns + the items
//     already discussed, such as the exact video that was recommended);
//  2. a small planner model decides what the turn needs (talk, live web
//     research, find a real video, talk about the video already chosen, play
//     or download it in extension 2, or recall);
//  3. each action is grounded: web answers come from pages actually read,
//     video recommendations only from real YouTube results with real lengths;
//  4. the chosen item is kept with the turn, so "what was its name?" /
//     "play it" work in this call and in the next call.
//
// Everything external is injected (deps), so this file is testable offline.

import { isCapabilityQuestion, SYSTEM_FACTS } from './caller-intent.js';
import { isZmanimQuestion, isNearbyQuestion, nearbyKind, spokenTime, sameTown, zmanimFacts as realZmanim, nearbyFacts as realNearby, spokenDistance } from './place-tools.js';

const HE_NUMBER_WORDS = { 'אחת': 1, 'אחד': 1, 'שתיים': 2, 'שניים': 2, 'שלוש': 3, 'שלושה': 3 };

// ---------- context ----------

export function refLine(ref) {
  if (!ref || typeof ref !== 'object') return '';
  if (ref.type === 'video') {
    const parts = ['סרטון יוטיוב שהוזכר: "' + String(ref.title || '').slice(0, 160) + '"'];
    if (ref.channelTitle) parts.push('ערוץ ' + String(ref.channelTitle).slice(0, 80));
    if (ref.durationSec) parts.push('אורך ' + spokenDuration(ref.durationSec));
    if (ref.videoId) parts.push('מזהה ' + ref.videoId);
    return '[' + parts.join(', ') + ']';
  }
  if (ref.type === 'lesson') return '[שיעור פעיל: ' + String(ref.topic || '').slice(0, 80) + ', שלב ' + (Number(ref.step) || 1) + ']';
  return '';
}

function clip(text, n) {
  const s = String(text || '').replace(/\s*¶\s*/g, '. ').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s;
}

/**
 * Builds the conversation context the models see, never longer than maxChars
 * (the free fast models refuse big requests). The newest turns are kept in
 * full first; older ones shrink, then drop.
 */
export function buildContext({ summary = '', prior = [], current = [], maxChars = 5200 } = {}) {
  const cur = (current || []).slice(-8).map(t => ({ user: t.user, assistant: t.assistant ?? t.gemini, ref: t.ref }));
  const old = (prior || []).slice(-10).map(t => ({ user: t.user, assistant: t.assistant ?? t.gemini, ref: t.ref, time: t.time }));
  const render = (turns, uMax, aMax, label) => turns.map(t =>
    label + 'מתקשר: ' + clip(t.user, uMax) + '\nתשובה: ' + clip(t.assistant, aMax) + (refLine(t.ref) ? '\n' + refLine(t.ref) : '')).join('\n');
  const head = summary ? 'סיכום שיחות קודמות עם המתקשר:\n' + clip(summary, 1400) + '\n\n' : '';
  for (const [cu, ca, ou, oa, keepOld] of [[400, 1200, 160, 260, 10], [300, 700, 120, 180, 6], [220, 420, 100, 140, 3], [180, 260, 0, 0, 0]]) {
    const oldPart = keepOld ? render(old.slice(-keepOld), ou, oa, '(שיחה קודמת) ') : '';
    let curTurns = cur;
    let text = '';
    for (;;) {
      const curPart = render(curTurns, cu, ca, '');
      text = head + (oldPart ? 'מתוך שיחות קודמות:\n' + oldPart + '\n\n' : '') + (curPart ? 'השיחה הנוכחית:\n' + curPart : 'השיחה הנוכחית רק התחילה.');
      if (text.length <= maxChars || curTurns.length <= 2) break;
      curTurns = curTurns.slice(1);
    }
    if (text.length <= maxChars) return text;
  }
  return (head + render(cur.slice(-2), 160, 240, '')).slice(-maxChars);
}

/** The newest video discussed (this call first, then earlier calls). */
export function activeVideo(current = [], prior = []) {
  for (const list of [current, prior]) {
    for (let i = (list || []).length - 1; i >= 0; i--) {
      const r = list[i]?.ref;
      if (r?.type === 'video' && /^[A-Za-z0-9_-]{11}$/.test(String(r.videoId || ''))) return r;
    }
  }
  return null;
}
export function activeLesson(current = []) {
  for (let i = (current || []).length - 1; i >= 0; i--) if (current[i]?.ref?.type === 'lesson') return current[i].ref;
  return null;
}

// ---------- planner ----------

export const INTENTS = ['library', 'chat', 'web', 'zmanim', 'nearby', 'video_find', 'video_about', 'video_play', 'media_status', 'cancel', 'read_page', 'recall'];

export function plannerPrompt({ context, utterance, now, video, older = null, media = '', prefs = [] }) {
  return [
    'אתה המתכנן של עוזרת טלפונית חכמה. קרא את ההקשר ואת מה שהמתקשר אמר עכשיו, והחלט מה התור הזה צריך. אל תענה למתקשר.',
    'התמלול של הטלפון לפעמים משבש מילים (למשל "יויוטב" במקום "יוטיוב", או שם של חברה שלא נאמר). פרש לפי ההקשר והכוונה, לא לפי מילה בודדת.',
    'אפשרויות intent:',
    'chat = שיחה, ברכה ("מה נשמע", "מה שלומך"), הסבר, לימוד, עצה, ידע כללי שאינו תלוי בפרטים מדויקים, המשך של שיעור או של הצעה קודמת ("כן", "תמשיכי", "אחת", "בטח").',
    'web = צריך מידע עדכני או מדויק מהאינטרנט: חדשות, מחירים, מי מכהן היום, פרטי עסק, אירועים אחרונים, נתונים שמשתנים, או כשהמתקשר מבקש לחפש. גם כל שאלה על פרט ספציפי מהעולם האמיתי שאפשר לטעות בו: מי שר שיר, איך נקרא זמר או צמד, אילו שירים יש לזמר, איך מגיעים ממקום למקום ובאיזה קו אוטובוס או רכבת, פרטים טכניים של שירות או מוצר. אלה web ולא chat, כדי לא לענות מהזיכרון.',
    'zmanim = שאלה על זמן הלכתי של היום במקום מסוים (סוף זמן קריאת שמע או תפילה לפי הגר"א או המגן אברהם, הנץ, שקיעה, עלות השחר, חצות, מנחה, פלג המנחה, צאת הכוכבים, כניסת שבת והדלקת נרות, צאת שבת). אלה זמנים שמחשבים לפי מיקום ותאריך, לא מחפשים באינטרנט.',
    'nearby = המתקשר שואל איפה יש מקום מסוג מסוים (בית כנסת, מקווה, בית מרקחת, סופר, מסעדה, כספומט, תחנת דלק, מרפאה, חניון וכו\') הכי קרוב או ליד מקום מסוים (רחוב, שכונה, חוף, מקום מוכר, יישוב).',
    'video_find = המתקשר רוצה שתמליצי או תמצאי לו סרטון, הרצאה, סיפור או סרט ביוטיוב.',
    'video_about = שאלה על סרטון שכבר הוזכר בשיחה (מה השם, תרגום השם, אורך, ערוץ, על מה הוא, האם הוא בעברית).',
    'video_play = המתקשר מבקש עכשיו לשמוע, להשמיע, להפעיל או להוריד סרטון או שיר מסוים (הסרטון שהוזכר, או שיר/סרטון שהוא מתאר בשמו). שאלה על מצב הורדה אינה video_play.',
    'media_status = שאלה על הורדה או הכנה שכבר התחילה: מה המצב, כמה אחוזים, מה מורידים עכשיו, האם מוכן.',
    'library = בקשה לשמוע אילו שירים או קבצים כבר הורדו ושמורים במערכת.',
    'cancel = המתקשר מבקש לבטל או לעצור הורדה, או אומר שלא רצה להוריד.',
    'read_page = המתקשר מבקש שתקריאי לו כתבה, מאמר או דף מאתר מסוים (למשל "תקריאי לי כתבה מחזקת מהידברות").',
    'recall = שאלה על שיחות קודמות או על פרטים שהמתקשר סיפר על עצמו.',
    'בנוסף: כשהמתקשר נותן הוראה קבועה לגבי איך לדבר איתו או על מה לא לדבר (למשל "אל תדברי איתי על חדשות", "תמיד תעני קצר", "תקראי לי בשם דוד"), כתבי אותה בשדה instruction כמשפט ברור, אחרת השאירי ריק.',
    'החזר JSON בלבד, בלי טקסט נוסף, בצורה:',
    '{"intent":"...","standalone":"השאלה כמשפט עצמאי וברור בעברית עם כל הפרטים מההקשר","search":"שאילתת חיפוש קצרה לאינטרנט אם intent=web או read_page","searches":["כששאל כמה דברים שונים שצריך לחפש (למשל מזג אוויר וגם שער הדולר): שאילתה קצרה נפרדת לכל אחד, עד 3; אחרת רשימה ריקה"],"yt_he":"שאילתת חיפוש ביוטיוב בעברית: לסרטון/שיר שהמתקשר מתכוון אליו לפי ההקשר (למשל שם הזמר והשיר שדובר עליהם), לא המשפט שאמר","yt_en":"אותה שאילתה באנגלית אם מתאים","min_minutes":0,"max_minutes":0,"recent_days":0,"order":"relevance או date או views","play":"audio או video","continue_offer":false,"instruction":"","place":"ל-zmanim/nearby: המקום עצמו (רחוב, שכונה, חוף, מקום מוכר או יישוב) בלי מילות יחס, ואם לא נאמר עכשיו - המקום שדובר עליו קודם בשיחה, אחרת ריק","town":"ל-zmanim/nearby: העיר או היישוב שבו המקום נמצא, ריק אם לא ידוע","date":"ל-zmanim: התאריך שעליו שאל בפורמט YYYY-MM-DD לפי הזמן עכשיו, ריק = היום","kind":"ל-nearby: סוג המקום שהוא מחפש, למשל בית כנסת"}',
    'שימי לב לשיבושי תמלול בשמות מקומות: "משוב" הוא כמעט תמיד "מושב", "קיבוצ" = "קיבוץ", "קביעת גאט" = "קריית גת". כשהמילה נשמעת כמו שם של יישוב בישראל, כתבי את שם היישוב הנכון כפי שהוא מוכר. כשהמתקשר אומר עכשיו מקום חדש, הוא מחליף את המקום שדובר עליו קודם.',
    'recent_days: כשביקש משהו חדש (השבוע=7, לאחרונה/חדש=30, היום=2). order: date כשביקש "הכי חדש", views כשביקש "הכי הרבה צפיות". שיר בודד = max_minutes 8, ואם אמר שאינו רוצה סט/רשימה/מיקס אל תחפשי סט.',
    'play = "video" רק כשהמתקשר ביקש במפורש להוריד את הווידאו/הסרטון עצמו. continue_offer = true כשהמתקשר רק מסכים להמשיך את מה שהוצע לו בתשובה הקודמת.',
    'min_minutes/max_minutes רק אם ביקש אורך (למשל "כשעה" = min 40).',
    '',
    'הזמן עכשיו בישראל: ' + now,
    video ? 'הסרטון שעליו מדברים עכשיו: ' + refLine(video) : older ? 'סרטון שהוזכר לפני כמה תורות (ייתכן שהשיחה כבר עברה לנושא אחר): ' + refLine(older) : 'לא הוזכר עדיין סרטון.',
    'הבנת הפניות: כשהמתקשר אומר "אותו", "הזה", "השיר שדיברנו עליו", "השני", "תסבירי יותר", "ומה עם...", קבעי לפי התשובה האחרונה וההקשר למה בדיוק הוא מתכוון. אם השיר או הסרטון שהוא מתכוון אליו הוזכר בשיחה (גם מתוך חיפוש באינטרנט או חדשות) ואינו הסרטון שלמעלה, כתבי ב-yt_he את השם המדויק שלו (זמר ושם שיר). ב-standalone כתבי את הבקשה המלאה עם השמות המפורשים, בלי "זה" ו"הוא".',
    'כשהמתקשר מבקש כמה דברים במשפט אחד, כתבי ב-standalone את כולם, כדי שהתשובה תענה על כל אחד מהם.',
    'תיקון: כשהמתקשר אומר "לא התכוונתי ל..." או "לא הבנת אותי", אל תחזרי על אותו חיפוש. הביני מההקשר מה כן רצה; אם עדיין לא ברור, intent=chat ו-standalone שמבקש ממנו להבהיר.',
    media ? 'הורדות בשיחה הזאת: ' + media : '',
    prefs.length ? 'הוראות קבועות של המתקשר: ' + prefs.join(' | ') : '',
    '',
    'הקשר:',
    context,
    '',
    'המתקשר אמר עכשיו: ' + utterance
  ].join('\n');
}

export function parsePlan(text) {
  const s = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!j || !INTENTS.includes(j.intent)) return null;
  const str = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return {
    intent: j.intent,
    standalone: str(j.standalone),
    search: str(j.search),
    searches: Array.isArray(j.searches) ? j.searches.map(str).filter(x => x.length >= 3 && !/^כששאל/.test(x)).slice(0, 3) : [],
    ytHe: str(j.yt_he),
    ytEn: str(j.yt_en),
    minMinutes: Math.max(0, Number(j.min_minutes) || 0),
    maxMinutes: Math.max(0, Number(j.max_minutes) || 0),
    play: j.play === 'video' ? 'video' : 'audio',
    continueOffer: j.continue_offer === true,
    recentDays: Math.max(0, Math.min(365, Number(j.recent_days) || 0)),
    order: ['date', 'views'].includes(j.order) ? j.order : 'relevance',
    instruction: str(j.instruction),
    place: str(j.place).slice(0, 80),
    town: str(j.town).slice(0, 60),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(j.date || '').trim()) ? String(j.date).trim() : '',
    kind: str(j.kind).slice(0, 40)
  };
}

const YT_WORD = /(?:יוטיוב|יויוטב|יוטוב|יו טיוב|youtube)/iu;
// 'Play' as the phone hears it: תשמיעי, תשמעי, תשמילי, תשמירי, תשמיעלי ... (all seen in calls).
export const PLAY_WORD = /(?:ש?תשמ(?:י?ע|יל|יר)(?:י|ו)?(?:לי)?(?![\u0590-\u05FF])|להשמיע|לשמוע את|תפעילי|תפעיל|תנגני|תנגן|לנגן|תורידי|תוריד|להוריד)/u;
const PLAY_WORD_G = new RegExp(PLAY_WORD.source, 'gu');
const POINT_WORD = /(?:אותו|אותה|זה|הזה|הזאת|שלו|שלה)(?![\u0590-\u05FF])/u;
// He points back at something found earlier in this call, not at the last thing said.
// 15.11: "the last video I talked with you about" (also from an earlier call).
export const BACKREF = /(?:ש(?:אמרת|מצאת|הצעת|המלצת|דיברנו|הזכרת|אמרתי|ביקשתי|דיברתי|דיברת|שאלתי|שאלת|חיפשתי|חיפשת|שמעתי|השמעת|הורדנו|הורדתי|הורדת|הזכרתי)|לפני כן|מקודם|קודם|הקודם|הקודמת|ההוא|ההיא|(?:הסרטון|השיר|הקליפ|השיעור) האחרון ש)(?![\u0590-\u05FF])/u;
const ORDINALS = [[/(?:ה?ראשון|ה?ראשונה|אפשרות (?:1|אחת)|מספר (?:1|אחת))(?![\u0590-\u05FF])/u, 0], [/(?:ה?שני|ה?שנייה|ה?שניה|אפשרות (?:2|שתיים)|מספר (?:2|שתיים))(?![\u0590-\u05FF])/u, 1], [/(?:ה?שלישי|ה?שלישית|אפשרות (?:3|שלוש)|מספר (?:3|שלוש))(?![\u0590-\u05FF])/u, 2]];
/** "מה מזג האוויר בירושלים וגם כמה עולה דולר" -> two separate searches. */
export function splitRequests(text) {
  const t = String(text || '').replace(/^(?:תגידי לי|תגיד לי|תבדקי לי|תבדוק לי|אני רוצה לדעת)\s+/u, '');
  const parts = t.split(/\s*(?:,\s*)?(?:וגם|ובנוסף|ועוד|וגם תגידי|ותגידי לי גם)\s+/u).map(x => x.trim()).filter(x => x.split(/\s+/).length >= 2);
  return parts.length >= 2 ? parts.slice(0, 3) : [];
}
export function ordinalOption(text, options) {
  if (!Array.isArray(options) || options.length < 2) return null;
  for (const [re, i] of ORDINALS) if (re.test(text) && options[i]) return options[i];
  return null;
}
const VIDEO_WORD = /(?:סרטון|סרטונים|סרט|הרצאה|וידאו|וידיאו|דוקו|תיעודי)/u;
const SONG_WORD = /(?:שיר|שירים|קליפ|סינגל|להיט|להיטים|הופעה|סט |מחרוזת|פרק|פרקים)/u;

// "...ליד החוף הנפרד באשקלון" -> { place: 'החוף הנפרד', town: 'אשקלון' };
// "...במושב עוצם" -> { place: '', town: 'עוצם' }. Only a fallback: the
// planner model reads places better, and its fields win when it answers.
export function placeFromText(text) {
  const t = String(text || '').replace(/[?!.,]/g, ' ').replace(/\bמשוב\b|(?<=\s|^)ב?משוב(?=\s)/gu, m => m.replace('משוב', 'מושב')).replace(/\s+/g, ' ').trim();
  const near = t.match(/(?:הכי קרוב|הקרוב ביותר|הקרובה ביותר|הכי קרובה|קרוב|קרובה|ליד|בסביבת|באזור של|בקרבת|מסביב)\s+(?:ל|אל\s+)?(.+)$/u);
  let rest = near ? near[1] : '';
  if (!rest) {
    // The place is in the last few words, after its "ב": the earliest such word
    // among the last three ("בבני ברק", not "ברק").
    const w = t.replace(/(?:היום|מחר|מחרתיים|השבוע|בבקשה|עכשיו)\s*$/u, '').trim().split(' ');
    for (let i = Math.max(0, w.length - 3); i < w.length; i++) if (/^ב[\u0590-\u05FF]{2,}/u.test(w[i])) { rest = [w[i].slice(1), ...w.slice(i + 1)].join(' '); break; }
  }
  rest = rest.replace(/(?:היום|מחר|מחרתיים|השבוע|בבקשה|עכשיו|לפי הגר[״"]?א|לפי הגרא|לפי המגן אברהם|במוצאי שבת|בשבת)/gu, ' ').replace(/^(?:ה?מושב|ה?קיבוץ|ה?יישוב|ה?עיר)\s+/u, '').replace(/\s+/g, ' ').trim();
  const town = near && rest.match(/^(.+?)\s+ב(?:עיר\s+|מושב\s+|קיבוץ\s+)?([\u0590-\u05FF][\u0590-\u05FF ]{1,25})$/u);
  if (town) return { place: town[1].trim(), town: town[2].trim() };
  const bare = rest;
  return /^(?:ה)?(?:חוף|רחוב|שכונת|כיכר|גן|פארק|מרכז|קניון|תחנת)/u.test(bare) ? { place: bare, town: '' } : { place: '', town: bare };
}

/** Used when every planner model is down: plain, conservative rules. */
export function heuristicPlan(utterance, { video = null } = {}) {
  const u = String(utterance || '').trim();
  const base = { standalone: u, search: u, ytHe: u.replace(YT_WORD, ' ').replace(/\s+/g, ' ').trim(), ytEn: '', minMinutes: 0, maxMinutes: 0, recentDays: /(?:השבוע|לאחרונה|חדש|חדשים|הכי טרי)/u.test(u) ? 30 : 0, order: 'relevance', instruction: '', place: '', town: '', date: '', kind: '', play: /(?:להוריד|תוריד|הורד).{0,20}(?:וידאו|וידיאו|סרטון עצמו)|כן לוידאו/u.test(u) ? 'video' : 'audio', continueOffer: false };
  // A key choice that names something to hear ("לשמיעת השיר X") is a play request.
  // "Do you download only from YouTube?" is a question about the system.
  if (isCapabilityQuestion(u)) return { ...base, intent: 'chat', about: true };
  const chosen = u.match(/^בחרתי באפשרות\s*\d+\s*:?\s*(.*)$/u);
  if (chosen && /(?:לשמיעת|להשמעת|לשמוע|להשמיע|לנגן|השיר|שיר|הסרטון|סרטון|הפרק|פרק)/u.test(chosen[1]) && !/(?:ביטול|המשך השיחה|לחיפוש|להמשך|שיחה על)/u.test(chosen[1]))
    return { ...base, intent: 'video_play', ytHe: chosen[1].replace(/(?:לשמיעת|להשמעת|לשמוע את|לשמוע|להשמיע את|להשמיע|לנגן את|לנגן|השיר|שיר|הסרטון|סרטון|הפרק|של\s+$)/gu, ' ').replace(/\s+/g, ' ').trim() };
  if (/^בחרתי באפשרות/u.test(u)) return { ...base, intent: 'chat', continueOffer: true };
  if (/(?:אילו|איזה|מה|תגיד|תגידי|תקריא|תקריאי|רשימת|רשימה של).{0,20}(?:שירים|קבצים|סרטונים|השירים|הקבצים).{0,25}(?:הורדתי|הורדנו|ירדו|שהורדת|שמורים|יש לי|כבר הורדו|במערכת)/u.test(u)) return { ...base, intent: 'library' };
  if (/(?:מצב|סטטוס|כמה אחוז|אחוזים|מה את מורידה|מה מורידים|מה את מכינה|כבר מוכן|מתי יהיה מוכן|ירד כבר|הורד כבר).{0,25}|(?:מצב|כמה).{0,10}(?:ההורדה|ההורדות|הקובץ)/u.test(u) && /(?:הורד|הורדה|הורדות|אחוז|מוכן|מכינה|קובץ)/u.test(u)) return { ...base, intent: 'media_status' };
  if (/(?:תבטל|תבטלי|לבטל|ביטול|תעצור|תעצרי|עצור|תפסיק|תפסיקי).{0,30}(?:הורד|הורדה|את זה|אותו)?|לא רוצה (?:שת|ש)?(?:ו)?ריד|אל תורידי|אל תוריד/u.test(u)) return { ...base, intent: 'cancel' };
  if (/(?:תקריא|תקריאי|תקראי|תקרא|להקריא).{0,30}(?:כתבה|מאמר|דף|אתר|סיפור מ)/u.test(u)) return { ...base, intent: 'read_page' };
  if (/^(?:כן|כן בבקשה|בטח|בוודאי|תמשיכי|תמשיך|המשיכי|נמשיך|אחת|אחד|1|יאללה|סבבה|אוקיי|אוקי)[.!? ]*$/u.test(u)) return { ...base, intent: 'chat', continueOffer: true };
  if (/(?:זוכר|זוכרת|דיברנו|אמרתי לך|שאלתי אותך|בפעם הקודמת|בשיחה הקודמת)/u.test(u) && !VIDEO_WORD.test(u)) return { ...base, intent: 'recall' };
  // Halachic times and "the nearest X to Y" are computed from the map, not
  // searched (18.11: both got poor web answers).
  if (isZmanimQuestion(u)) return { ...base, intent: 'zmanim', ...placeFromText(u) };
  if (isNearbyQuestion(u)) return { ...base, intent: 'nearby', kind: nearbyKind(u).label, ...placeFromText(u) };
  // The video named in the request, not the whole sentence, is what gets searched.
  if (PLAY_WORD.test(u) && !/^(?:לא|אל)(?=$|[\s,.!?])/u.test(u)) return { ...base, intent: 'video_play', ytHe: video && POINT_WORD.test(u) ? '' : u.replace(PLAY_WORD_G, ' ').replace(/(?:הלו|נו|כן|בבקשה|אני רוצה|ש?תשמיעי|לי|את|השיר|הסרטון|הפרק|ה?ו?וידי?או|קובץ שמע|ביוטיוב|יוטיוב)/gu, ' ').replace(/\s+/g, ' ').trim() };
  if (video && /(?:השם|איך קוראים|איך נקרא|כמה זמן|אורך|ארוך|הערוץ|באנגלית|בעברית|תתרגם|תתרגמי|על מה הוא|מה יש ב)/u.test(u) && (VIDEO_WORD.test(u) || /(?:אותו|שלו|זה)/u.test(u))) return { ...base, intent: 'video_about' };
  if ((YT_WORD.test(u) || VIDEO_WORD.test(u) || SONG_WORD.test(u)) && /(?:תמליצ|ממליצ|מומלץ|תמצא|תמצאי|תחפש|תחפשי|אני מחפש|יש סרטון|איזה סרטון|איזה שיר|מה השיר|תביא|תביאי|הכי חדש|חדש של|שיצא|שיצאו)/u.test(u)) return { ...base, intent: 'video_find' };
  if (/(?:תחפש|תחפשי|חפש|חפשי|באינטרנט|ברשת|בגוגל|עדכני|היום|עכשיו|חדשות|מחיר|כמה עולה|שער|מזג האוויר|מי ראש|מי שר|מי נשיא|מתי פתוח|שעות פתיחה|טלפון של)/u.test(u)) return { ...base, intent: 'web' };
  return { ...base, intent: 'chat' };
}

// ---------- YouTube ----------

// Titles that must never be read to the caller or recommended.
const UNSAFE_TITLE = /(?:סקס|פורנו|עירום|ערום|ציצים|תמצצ|מצוצ|זיון|זונה|זונות|ערוםה|חשפנ|אירוטי|nsfw|porn|sex|nude|naked|xxx|onlyfans|boobs|hentai|erotic|strip|twerk|bikini|lingerie|גופייה שקופה|\bfuck|\bshit|\bbitch|מטומטמת|כוס אמא)/iu;
export function isSafeVideo(v) {
  const text = [v?.title, v?.channelTitle, String(v?.description || '').slice(0, 300)].join(' ');
  return !UNSAFE_TITLE.test(text) && !v?.ageRestricted;
}

export function parseIsoDuration(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

export function spokenDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h && m) return (h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : h + ' שעות') + ' ו ' + m + ' דקות';
  if (h) return h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : h + ' שעות';
  return (m || 1) + ' דקות';
}
function spokenViews(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return 'כ ' + (Math.round(v / 1e5) / 10) + ' מיליון צפיות';
  if (v >= 1e3) return 'כ ' + Math.round(v / 1e3) + ' אלף צפיות';
  return v ? v + ' צפיות' : '';
}

export function youtubeKeys(env = process.env) {
  return [...new Set([env.YOUTUBE_API_KEY, env.YOUTUBE_BACKUP_API_KEY, ...[2, 3, 4, 5, 6, 7, 8, 9].map(n => env['YOUTUBE_API_KEY_' + n])]
    .map(k => String(k || '').trim()).filter(Boolean))];
}
const restingKeys = new Map();
async function youtubeGet(path, params, opts = {}) {
  try { return await youtubeGetOwn(path, params, opts); }
  catch (e) {
    // Own keys missing or used up: the extension-2 service's keys (rotated there).
    if (opts.proxy && e?.status === 503) return opts.proxy(path, params);
    throw e;
  }
}
async function youtubeGetOwn(path, params, { env = process.env, fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const keys = youtubeKeys(env).filter(k => (restingKeys.get(k) || 0) < Date.now());
  if (!keys.length) throw Object.assign(new Error('No YouTube key available'), { status: 503 });
  let last;
  for (const key of keys) {
    const u = new URL('https://www.googleapis.com/youtube/v3/' + path);
    for (const [k, v] of Object.entries({ ...params, key })) u.searchParams.set(k, String(v));
    try {
      const r = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 403 || r.status === 429) { restingKeys.set(key, Date.now() + 3600000); last = Object.assign(new Error('YouTube key refused ' + r.status), { status: 503 }); continue; }
      if (!r.ok) throw Object.assign(new Error('YouTube HTTP ' + r.status), { status: 502 });
      return j;
    } catch (e) { last = e; if (e?.status === 502) throw e; }
  }
  throw last || Object.assign(new Error('YouTube unavailable'), { status: 503 });
}

const decode = s => String(s || '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Real search + real details (length, views, date). Never invents anything. */
// What a phone listener needs from a description: no links, phone numbers,
// hashtags, emojis or "follow us" lines.
export function cleanDescription(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/(?:\+?972|0)[\d\-\s]{7,13}\d/g, ' ')
    .replace(/[#@][\w\u0590-\u05FF_]+/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .split(/\n+/).filter(l => !/(?:follow|subscribe|instagram|facebook|tiktok|spotify|להזמנת הופעות|ניהול אישי|ייצוג|הצטרפו|הירשמו|לפרטים|הזמנות|חייגו|join the channel|prod\.? by)/i.test(l)).join(' ')
    .replace(/\s+/g, ' ').trim();
}
// Words that describe what he wants (full, newest, find me on YouTube), not
// words that must appear in the title: "ארץ נהדרת פרק מלא הכי חדש" searches
// "ארץ נהדרת", long, newest first.
const YT_FILLER = /(?:^|\s)(?:תמצאי|תמצא|תמצאו|מצאי|תחפשי|תחפש|חפשי|תביאי|תביא|לי|בבקשה|אני|רוצה|מחפש|ביוטיוב|ביויוטב|יוטיוב|יויוטב|ביוטוב|youtube|באורך|מלא|המלא|מלאה|המלאה|ארוך|הארוך|ארוכה|הכי|חדש|החדש|חדשה|החדשה|חדשים|האחרון|אחרון|האחרונה|אחרונה|ביותר|שיצא|שיצאה|עכשיו|לאחרונה|את|של|גם|רק|תשמיעי|תשמיע|להשמיע|לשמוע|תורידי|תוריד|להוריד|סרטון|הסרטון|ה?ו?וידי?או|קליפ|הקליפ)(?=$|\s)/gu;
export function ytSubject(q) {
  const t = ' ' + String(q || '').replace(/[,.!?:;"'״׳()\-–]/g, ' ').replace(/\s+/g, ' ') + ' ';
  let out = t, prev;
  do { prev = out; out = out.replace(YT_FILLER, ' '); } while (out !== prev);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length >= 2 ? out : String(q || '').trim();
}
export const NEWEST = /(?:הכי חדש|הכי חדשה|האחרון|האחרונה|החדש ביותר|החדשה ביותר|הכי עדכני|שיצא עכשיו|שיצא השבוע|שיצא לאחרונה|newest|latest)/iu;
/** A title fit to read aloud and to put before a key: no "(Prod. by ...)", pipes or commas. */
export function cleanTitle(t) {
  return String(t || '')
    .replace(/[\(\[][^)\]]*(?:prod|official|video|audio|lyrics|קליפ רשמי|רשמי|hd|4k)[^)\]]*[\)\]]/giu, ' ')
    .replace(/(?:prod\.?|produced)\s*(?:by)?\s*[^|,]*$/iu, ' ')
    .replace(/(?:official\s*(?:music)?\s*video|official audio|הקליפ הרשמי|קליפ רשמי)/giu, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/[|,.:;!?#*_"~]+/g, ' ').replace(/\s+-\s+/g, ' - ').replace(/\s+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '').trim();
}
export async function findVideos(queries, { minMinutes = 0, maxMinutes = 0, recentDays = 0, order = 'relevance', exclude = [], env, fetchImpl, proxy, regionCode = 'IL' } = {}) {
  const qs = [...new Set((queries || []).map(q => String(q || '').trim()).filter(q => q.length >= 2).map(q => /[֐-׿]/.test(q) ? ytSubject(q) : q))].slice(0, 3);
  const duration = minMinutes >= 20 ? 'long' : (maxMinutes && maxMinutes <= 4) ? 'short' : (minMinutes >= 4 && (!maxMinutes || maxMinutes <= 20)) ? 'medium' : 'any';
  // "Newest": a relevance search and a date search together, then the newest
  // of the ones that are really about it (a date-only search brings noise).
  const plan = order === 'date' ? [...qs.map(q => [q, 'relevance']), [qs[0], 'date']] : qs.map(q => [q, order === 'views' ? 'viewCount' : 'relevance']);
  const lists = await Promise.allSettled(plan.map(([q, ord]) => youtubeGet('search', {
    part: 'snippet', q, type: 'video', maxResults: order === 'date' ? 25 : 15, safeSearch: 'strict', regionCode, relevanceLanguage: /[a-z]/i.test(q) && !/[֐-׿]/.test(q) ? 'en' : 'he', videoDuration: duration,
    order: ord,
    ...(recentDays ? { publishedAfter: new Date(Date.now() - recentDays * 86400000).toISOString().replace(/\.\d+Z$/, 'Z') } : {})
  }, { env, fetchImpl, proxy })));
  const seen = new Set((exclude || []).map(String)), ids = [];
  for (const l of lists) for (const it of (l.status === 'fulfilled' ? l.value.items || [] : [])) {
    const id = it?.id?.videoId;
    if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
  }
  if (!ids.length) {
    const failed = lists.find(l => l.status === 'rejected');
    if (failed) throw failed.reason;
    return [];
  }
  const details = await youtubeGet('videos', { part: 'snippet,contentDetails,statistics', id: ids.slice(0, 45).join(',') }, { env, fetchImpl, proxy });
  let videos = (details.items || []).map(v => ({
    videoId: v.id,
    title: decode(v.snippet?.title),
    channelTitle: decode(v.snippet?.channelTitle),
    description: cleanDescription(decode(v.snippet?.description)).slice(0, 600),
    publishedAt: v.snippet?.publishedAt || null,
    language: v.snippet?.defaultAudioLanguage || v.snippet?.defaultLanguage || '',
    durationSec: parseIsoDuration(v.contentDetails?.duration),
    viewCount: Number(v.statistics?.viewCount) || 0,
    ageRestricted: v.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted',
    live: v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none'
  })).filter(v => v.videoId && v.durationSec > 0 && !v.live && isSafeVideo(v));
  const rank = new Map(ids.map((id, i) => [id, i]));
  if (minMinutes) videos = videos.filter(v => v.durationSec >= minMinutes * 60 * 0.75);
  if (maxMinutes) videos = videos.filter(v => v.durationSec <= maxMinutes * 60 * 1.25);
  // Relevance order from YouTube, nudged by popularity (or newest / most viewed when asked).
  const subjectWords = String(qs[0] || '').replace(/[^\u0590-\u05FFa-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !['שיר', 'השיר', 'פרק', 'הפרק', 'פרקים'].includes(w));
  const subjectFit = v => { if (!subjectWords.length) return 1; const t = (String(v.title || '') + ' ' + String(v.channelTitle || '')).toLowerCase().replace(/[^\u0590-\u05FFa-z0-9 ]/g, ' '); return subjectWords.filter(w => t.includes(w.toLowerCase())).length / subjectWords.length; };
  if (order === 'date') {
    const top = Math.max(0, ...videos.map(subjectFit));
    if (top >= 0.99) videos = videos.filter(v => subjectFit(v) >= 0.99);
    // The show's own uploads first (its channel, or a broadcaster), then talk about it.
    const own = v => { const c = String(v.channelTitle || '').toLowerCase(); return subjectWords.length && subjectWords.every(w => c.includes(w.toLowerCase())) ? 2 : /(?:keshet|קשת|mako|מאקו|reshet|רשת|כאן|kan |kan11|ערוץ 14|now14|i24|חדשות 12|N12)/i.test(c) ? 1 : 0; };
    const lead = v => String(v.title || '').toLowerCase().replace(/[^\u0590-\u05FFa-z0-9 ]/g, ' ').trim().startsWith(subjectWords.join(' ').toLowerCase()) ? 1 : 0;
    videos.sort((a, b) => (own(b) - own(a)) || (lead(b) - lead(a)) || (Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0)));
  }
  else if (order === 'views') videos.sort((a, b) => b.viewCount - a.viewCount);
  else {
    // The original song first: karaoke, covers, lyric and remix uploads only when he asked for one.
    const ALT = /(?:קריוקי|karaoke|cover|קאבר|lyrics|lyric video|מילים|instrumental|פלייבק|playback|remix|רמיקס|\b8d\b|slowed|sped up|נייטקור|nightcore|tiktok|טיקטוק)/iu;
    const askedAlt = ALT.test((queries || []).join(' '));
    const alt = v => (!askedAlt && ALT.test(v.title)) ? 8 : 0;
    // When he named a song, the titles that carry all of his words come first
    // ("אושר כהן דאון" -> the versions of "דאון"), and among those the original.
    const STOP = new Set(['שיר', 'השיר', 'של', 'את', 'לי', 'סרטון', 'הסרטון', 'בבקשה', 'קליפ', 'הקליפ', 'פרק', 'הפרק', 'פרקים']);
    const qWords = String(qs[0] || '').replace(/[^\u0590-\u05FFa-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
    const fit = v => { if (!qWords.length) return 0; const t = String(v.title || '').toLowerCase(); return qWords.filter(w => t.includes(w.toLowerCase())).length / qWords.length; };
    const best = Math.max(0, ...videos.map(fit));
    if (qWords.length && qWords.length <= 6 && best >= 0.99) videos = videos.filter(v => fit(v) >= 0.99);
    if (!askedAlt && videos.some(v => !ALT.test(v.title))) videos = videos.filter(v => !ALT.test(v.title));
    videos.sort((a, b) => (rank.get(a.videoId) + alt(a) - rank.get(b.videoId) - alt(b)) - 4 * (Math.log10(b.viewCount + 10) - Math.log10(a.viewCount + 10)));
  }
  return videos.slice(0, 10);
}

/** The full title first, then 1 audio / 2 video / 3 cancel; nothing is downloaded before a choice. */
export function confirmFor(v, mode = 'audio') {
  return {
    confirm: { videoId: v.videoId, title: v.title, channelTitle: v.channelTitle, durationSec: v.durationSec, language: v.language || '', mode },
    reply: 'לפני שאני מורידה, רק לוודא שזה הסרטון הנכון: ' + v.title + (v.channelTitle ? ', בערוץ ' + v.channelTitle : '') + (v.durationSec ? ', אורכו ' + spokenDuration(v.durationSec) : '') + '. ' +
      'להורדת קובץ שמע הקש 1, להורדת וידאו עם אפשרות לכתובית בעברית הקש 2, לביטול והמשך השיחה הקש 3. אפשר גם לומר אחת, שתיים או שלוש.'
  };
}

export function videoRef(v) {
  return { type: 'video', videoId: v.videoId, title: v.title, channelTitle: v.channelTitle, durationSec: v.durationSec, viewCount: v.viewCount, publishedAt: v.publishedAt, language: v.language };
}

function candidatesText(videos) {
  return videos.map((v, i) => JSON.stringify({ i, title: v.title, channel: v.channelTitle, minutes: Math.round(v.durationSec / 60), views: v.viewCount, published: String(v.publishedAt || '').slice(0, 10), language: v.language || 'לא ידוע', description: clip(v.description, 260) })).join('\n');
}

// ---------- answers ----------

export const PHONE_STYLE = [
  'את מדברת בטלפון, בעברית טבעית, חמה וזורמת, כמו מומחית אמיתית שאוהבת להסביר. התשובה מוקראת בקול, אז בלי סימני עיצוב, בלי רשימות עם כוכביות, בלי קוד מוקלד ובלי קישורים.',
  'המתקשר הוא גבר: פני אליו תמיד בלשון זכר (אתה, תרצה, תגיד). את עצמך מדברת בלשון נקבה.',
  'ענה בהרחבה ובפירוט מלא, כמו מומחית שמסבירה לחבר בכיף ובזרימה: קודם תשובה ישירה, אחר כך הסבר עשיר ומסודר עם הפרטים החשובים, דוגמאות מהחיים ותובנות מעניינות, ובסוף משפט סיכום או שאלת המשך אחת שמקדמת את השיחה. תשובה רגילה: כ-10 משפטים מלאים כשיש באמת מה להסביר. כשמבקשים "בהרחבה" או "בפירוט": 15 עד 25 משפטים. כשהמתקשר מבקש לקצר, או כשהתשובה קצרה מטבעה (שעה, שם, מספר, כן או לא, ברכה), ענה קצר. האורך לעולם לא בא על חשבון האמת: אסור להוסיף פרטים שאינך בטוחה בהם רק כדי להאריך. עדיף תשובה קצרה ונכונה מאשר ארוכה עם המצאות.',
  'עני על כל חלקי השאלה. כשאת לא יודעת פרט, אמרי זאת במפורש ("את שמך עוד לא אמרת לי") והמשיכי לשאר השאלה.',
  'אל תאמרי "המקורות שסופקו" או "לפי ההקשר": דברי בטבעיות, למשל "לפי מה שמצאתי עכשיו".',
  'כשאת מציעה למתקשר לבחור בין כמה אפשרויות, קודם הסבירי במשפט או שניים מה כל אפשרות, ואז אמרי אותן בפורמט קבוע עם השם האמיתי של כל אפשרות לפני המקש, למשל: "למשתנים ונתונים הקש 1, לתנאים והחלטות הקש 2, ללולאות הקש 3", עד 6 אפשרויות, ואמרי שאפשר גם לומר את המספר. אסור לכתוב "הנושא הראשון" במקום שם אמיתי. המקשים האלה באמת עובדים בשיחה. כשהמתקשר בחר אפשרות, התחילי מיד את מה שבחר, בפירוט, בלי לחזור על הרשימה.',
  'אל תמציאי שום עובדה: שמות של אנשים, זמרים, צמדים ולהקות, שמות שירים ואלבומים, קווי אוטובוס ומסלולים, כתובות, טלפונים, מחירים, תאריכים, סרטונים, ערוצים או ציטוטים. כשאינך בטוחה בפרט, אמרי זאת בפשטות והציעי לחפש באינטרנט (הוא יכול לומר "תחפשי באינטרנט"). אל תסתירי אי ודאות מאחורי תשובה ארוכה.',
  'מה שהמערכת באמת יודעת לעשות בשיחה: לחפש באינטרנט, למצוא סרטון או שיר ביוטיוב, להוריד שיר או סרטון אחד בכל פעם אחרי שהמתקשר בוחר במקשים, להשמיע שירים שכבר שמורים, להקריא כתבה מאתר, לחשב זמני היום ההלכתיים, ולמצוא במפה מקומות קרובים. אסור להבטיח דברים אחרים: לא קבצי ZIP, לא קישורים להורדה, לא שליחת הודעות או מיילים, לא הורדה של אלבום שלם או של כל השירים של זמר בבת אחת, לא איכות 320 ולא "אעדכן אותך אחר כך" על משהו שלא קורה באמת.',
  // Owner, 12.11: no stock phrases; talk like a real, warm person.
  'פתחי ישר בתוכן עצמו. אסור לפתוח במילות נימוס קבועות כמו "שמחתי לשמוע", "שמחה לעזור", "שאלה מצוינת", "שאלה טובה", "בשמחה", "בהחלט", "כמובן", "תודה ששאלת", ואסור לחזור מתשובה לתשובה על אותם ביטויים, אותה פתיחה או אותה שאלת סיום. דברי כמו אדם אמיתי: חם, נעים, סקרן ומגוון, עם הומור עדין כשמתאים, כמו חבר חכם שכיף לדבר איתו.',
  'את לא משמיעה ולא מורידה בעצמך דרך מה שאת כותבת: אל תאמרי "משמיעה עכשיו" ואל תבטיחי להשמיע. כשהמתקשר רוצה לשמוע משהו, אמרי לו לומר "תשמיעי לי את" ואת שם השיר או הסרטון.'
].join(' ');
// Stock openings that slip through anyway are cut off the answer.
const STOCK_OPENING = /^(?:\s*(?:(?:אני\s+)?(?:שמחתי|שמחה|שמח)\s+(?:מאוד\s+)?(?:לשמוע|לעזור|שפנית|ששאלת|שאתה|על)[^.!?,]*[.!?,]|(?:איזו\s+|זו\s+)?שאלה\s+(?:מצוינת|טובה|מעולה|נהדרת|יפה|מעניינת)[^.!?,]*[.!?,]|בשמחה[.!?,]|בהחלט[.!?,]|כמובן[.!?,]|תודה (?:ששאלת|על השאלה)[^.!?,]*[.!?,])\s*)+/u;
// 13.11: a small model began with its own note to itself ("בבקשה, בוצע קיצור").
const META_OPENING = /^\s*(?:בבקשה[,.!]?\s*)?(?:בוצע קיצור|קיצרתי|הנה התשובה(?: המקוצרת)?|תשובה מקוצרת|הנה גרסה מקוצרת|הנה הניסוח)[,.:!]?\s*/u;
export function cutStockOpening(text) { const t = String(text || '').replace(META_OPENING, ''); const cut = t.replace(STOCK_OPENING, ''); return cut.length > 20 ? cut : t; }

// Extension 1 speaks as a man and answers briefly; extension 3 as a woman, at length.
const MALE_SELF = [['מורידה','מוריד'],['מעירה','מעיר'],['ממשיכה','ממשיך'],['משמיעה','משמיע'],['מקשיבה','מקשיב'],['מכינה','מכין'],['יכולה','יכול'],['בטוחה','בטוח'],['זוכרת','זוכר'],['ממליצה','ממליץ'],['יודעת','יודע'],['מבינה','מבין'],['מחפשת','מחפש'],['מצטערת','מצטער'],['שמחה לעזור','שמח לעזור'],['תשמיעי','תשמיע'],['תורידי','תוריד'],['תמשיכי','תמשיך'],['תקריאי','תקריא']];
export function toMaleSelf(text) {
  let t = String(text || '');
  for (const [f, m] of MALE_SELF) t = t.replace(new RegExp('(?<![\\u0590-\\u05FF])' + f + '(?![\\u0590-\\u05FF])', 'gu'), m);
  return t;
}
export function voiceRule(voice = 'female') {
  return voice === 'male' ? 'חשוב: אתה עוזר גבר בטלפון. דבר על עצמך תמיד בלשון זכר (אני מוצא, אני מוריד, אני ממליץ, הבנתי), גם אם ההוראות למעלה כתובות בלשון נקבה.' : '';
}
export function lengthRule(brief = false, utterance = '') {
  if (!brief) return '';
  return /(?:בהרחבה|בפירוט|תפרט|תפרטי|תרחיב|תרחיבי|לעומק|באריכות|תסביר לי הכל|הכל על)/u.test(utterance)
    ? 'כלל אורך שגובר על כל הוראה אחרת: המתקשר ביקש פירוט, אז ענה מפורט אבל ממוקד, עד 12 משפטים.'
    : 'כלל אורך שגובר על כל הוראה אחרת למעלה: ענה תשובה רגילה ולא ארוכה, 3 עד 6 משפטים ברורים, ישר לעניין, עם הפרט החשוב ביותר (מספר, שעה, שם) בהתחלה ועם ההסבר החיוני בלבד. אל תרחיב אלא אם המתקשר מבקש "בהרחבה" או "תפרט". כשאתה מציע אפשרויות במקשים, אמור אותן במלואן גם בתשובה קצרה.';
}

export function teachingRule(lesson) {
  return 'כשהמתקשר רוצה ללמוד נושא (למשל תכנות), את המורה שלו כאן בטלפון: מלמדת שיעור אמיתי בשלבים, מסבירה מושג אחד או שניים בכל פעם בדוגמאות מהחיים, מתארת קוד במילים (למשל "כותבים פְּרִינְט, פותחים סוגריים...") ולא מפנה לאתרים, לקורסים או לסרטונים. בסוף כל שלב שאלי אם להמשיך לשלב הבא. ' +
    (lesson ? 'כרגע יש שיעור פעיל: ' + refLine(lesson) + '. אם המתקשר אומר כן או תמשיכי, המשיכי ישר לשלב הבא שלו בלי לחזור על ההקדמה. ' : '');
}

// Standing instructions the caller gave ("don't talk about X", "always short").
// ---------- speaking style the caller chose ("from now on talk sarcastically") ----------
export const STYLE_PREFIX = 'סגנון דיבור: ';
const STYLE_WORDS = [
  [/עוקצ|עקיצ|ארס|ציני|צינית|סרקז|חצוף|חצופה|שנון|שנונה/u, 'עוקצני ושנון: הומור חד, עקיצות חביבות וקריצות, תשובות עם "טוויסט", כמו חבר שאוהב לעקוץ. לעקוץ בחיבה בלבד, בלי להעליב באמת, בלי קללות ובלי לפגוע, ועדיין לענות על השאלה במלואה ובדיוק'],
  [/מצחיק|מצחיקה|בהומור|הומוריסט|משעשע|צחוקים|קורע/u, 'בהומור: קליל, משעשע ומלא בדיחות קטנות ודימויים מצחיקים, ועדיין לענות על השאלה במלואה ובדיוק'],
  [/רשמי|רשמית|מכובד|מכובדת|ענייני|עניינית|מקצועי|מקצועית/u, 'רשמי וענייני: מנומס, מדויק ומקצועי, בלי בדיחות וסלנג'],
  [/רגוע|רגועה|רך|רכה|עדין|עדינה|חם|חמה|נעים|נעימה/u, 'רגוע וחם: רך, נעים ומרגיע'],
  [/נלהב|נלהבת|אנרגטי|אנרגטית|בהתלהבות|שמח|שמחה/u, 'נלהב ואנרגטי: מלא התלהבות ושמחה'],
  [/סלנג|ישראלי|כמו חבר|חברי|חברית|בגובה העיניים/u, 'כמו חבר בגובה העיניים: סלנג ישראלי קליל ונעים, בלי מילים גסות']
];
const ASKS_STYLE = /(?:תדברי|תדבר|דברי|דבר|תעני|תענה|ענה|עני|תהיי|תהיה|להיות|תשתמשי|לדבר)\s+(?:איתי\s+|אליי\s+|אלי\s+)?(?:ב?אופן\s+|ב?צורה\s+|ב?סגנון\s+|כמו\s+)?/u;
const BACK_TO_NORMAL = /(?:(?:תדברי|תדבר|דברי|דבר|תחזרי|תחזור|חזרי|חזור|תעני|תענה)(?:\s+(?:איתי|אליי|לדבר))?\s+(?:ל)?(?:רגיל|רגילה|כרגיל|נורמלי|נורמלית|כמו קודם|כמו תמיד|כמו שהיית|בסגנון הרגיל))|(?:תפסיקי|תפסיק|די|מספיק)\s+(?:עם\s+)?(?:ה)?(?:עקיצות|ציניות|סרקזם|בדיחות|הומור|ארס|הסגנון)/u;
export function styleRequest(utterance) {
  const u = String(utterance || '');
  if (BACK_TO_NORMAL.test(u)) return { reset: true };
  if (!ASKS_STYLE.test(u) && !/(?:מעכשיו|מהיום|מעתה)/u.test(u)) return null;
  for (const [re, desc] of STYLE_WORDS) if (re.test(u)) return { style: desc };
  // Any other style in his own words ("like a teacher", "in grandma's style"),
  // but not a topic ("talk to me about planes").
  const own = u.match(/(?:כמו|בסגנון(?:\s+של)?|באופן|בצורה|בטון)\s+(.{2,60})$/u);
  if (own && !/\sעל\s/u.test(u) && u.split(/\s+/).length <= 12) return { own: own[1].replace(/[.!?]+$/, '').trim(), style: own[1].replace(/[.!?]+$/, '').trim() + ': לדבר בסגנון הזה בדיוק כפי שהמתקשר תיאר, בטבעיות, ועדיין לענות על השאלה במלואה ובדיוק' };
  return null;
}

export function prefsBlock(prefs = []) {
  const list = (prefs || []).map(x => String(x || '').trim()).filter(Boolean).slice(-15);
  const style = list.filter(x => x.startsWith(STYLE_PREFIX)).pop();
  const rules = list.filter(x => !x.startsWith(STYLE_PREFIX));
  return [rules.length ? 'הוראות קבועות שהמתקשר נתן לך. חובה לקיים אותן תמיד, בכל תשובה, גם בשיחות הבאות:\n- ' + rules.join('\n- ') : '',
    style ? 'המתקשר ביקש שתדברי איתו מעכשיו בסגנון הזה, וזה גובר על הוראות הטון למעלה (אבל לא על הדיוק ועל הכבוד): ' + style.slice(STYLE_PREFIX.length) + '. המשיכי בסגנון הזה בכל תשובה עד שיבקש לחזור לרגיל.' : ''].filter(Boolean).join('\n');
}

export function answerPrompt({ context, utterance, plan, now, instruction, extra = '', lesson = null, prefs = [], media = '', stuck = false, voice = 'female', brief = false, compliment = false, tip = false }) {
  return [
    instruction,
    PHONE_STYLE,
    teachingRule(lesson),
    prefsBlock(prefs),
    media ? 'מצב ההורדות בשיחה (אמיתי): ' + media : '',
    stuck ? STUCK_RULE : '',
    plan?.continueOffer ? 'המתקשר הסכים עכשיו להצעה מהתשובה הקודמת שלך, או בחר אחת מהאפשרויות שהצעת. המשיכי בדיוק משם, בפירוט, בלי לשאול שוב מה הוא רוצה ובלי לחזור על הרשימה.' : '',
    'הזמן עכשיו בישראל: ' + now + '.',
    '',
    'הקשר השיחה:',
    context,
    extra ? '\n' + extra : '',
    '',
    'המתקשר אמר עכשיו: ' + utterance,
    plan?.standalone && plan.standalone !== utterance ? 'הכוונה שלו: ' + plan.standalone : '',
    UNDERSTAND_RULE,
    '',
    voiceRule(voice),
    // Owner, 12.11 (extension 3): now and then a real compliment, never flattery.
    compliment ? 'בתשובה הזאת מותר לך, רק אם יש לזה סיבה אמיתית בשיחה, לשלב מחמאה קצרה וכנה אחת על משהו ספציפי שהמתקשר אמר או עשה (שאלה חכמה שחשב עליה, רעיון יפה, סקרנות, הומור, התמדה בלימוד), במשפט אחד טבעי באמצע או בסוף התשובה, ולא בפתיחה. בלי הגזמה, בלי מילים כמו "מדהים" או "גאון", ובלי לחזור על מחמאה שכבר נאמרה. אם אין סיבה אמיתית, אל תחמיאי בכלל.' : '',
    // Owner, 19.11: a useful tip now and then, and whenever he asks for tips.
    TIPS_ASKED.test(utterance) ? 'המתקשר ביקש טיפים או עצות: תני כמה טיפים מעשיים, ברורים ומועילים באמת, כל אחד במשפט או שניים.' : tip ? 'אם יש טיפ מעשי אחד שבאמת יעזור לו בנושא הזה, הוסיפי אותו בסוף התשובה במשפט אחד שמתחיל ב"טיפ קטן:". אם אין טיפ אמיתי ומועיל, אל תוסיפי.' : '',
    lengthRule(brief, utterance),
    'החזר אובייקט JSON תקין בלבד עם שדה "answer".'
  ].filter(x => x !== '').join('\n');
}

// Owner, 13.11: answer exactly what he meant, also in follow-ups.
export const UNDERSTAND_RULE = 'לפני שאת עונה, הביני בדיוק מה הוא רוצה עכשיו לפי ההקשר: "תסבירי יותר", "תרחיבי" או "לא הבנתי" = הרחיבי על הנושא האחרון, בדרך אחרת ועם פרטים ודוגמאות חדשים, בלי לחזור על מה שכבר אמרת. "ומה עם...", "והשני?", "ואם..." = עני על אותה שאלה לגבי הדבר שהזכיר עכשיו. כמה בקשות במשפט אחד = עני על כל אחת מהן לפי הסדר, אף אחת לא נשמטת. תיקון ("לא, התכוונתי ל...") = קבלי אותו ועני לפי הכוונה המתוקנת, בלי התנצלות ארוכה ובלי לחזור על הטעות. "זה", "הוא", "אותו" = הדבר האחרון שדיברתם עליו.';
// Owner, 11.11: when the talk goes in circles, stop guessing and let him
// choose with keys.
export const STUCK_RULE = 'נראה שאנחנו לא מבינים אחד את השני, או שהמתקשר חוזר על אותה בקשה או מבקש לבחור במקשים. אל תנחשי שוב ואל תחזרי על התשובה הקודמת. אמרי במשפט אחד מה הבנת שהוא מבקש, ואז הציעי 2 עד 5 אפשרויות ברורות ושונות במקשים. כל אפשרות חייבת להיאמר בדיוק בצורה "ל<שם האפשרות> הקש <מספר>", למשל "ללימוד משתנים הקש 1, ללימוד תנאים הקש 2, ללימוד לולאות הקש 3". בלי רשימה ממוספרת ובלי "בחרי מספר". פני אליו בלשון זכר. כשהוא יקיש, תמשיכי בדיוק לפי בחירתו.';
// Safety net: a numbered list ("1, משתנים, 2, תנאים") becomes real key options
// ("למשתנים הקש 1, לתנאים הקש 2") so the call can wait for the key.
export function numberedToKeys(text) {
  const t = String(text || '');
  const parts = t.split(/(?:^|[,.:;]\s*|\s)([1-9])\s*[,.:)\-]\s+/u);
  if (parts.length < 5) return t;
  const intro = parts[0].trim(), opts = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    if (Number(parts[i]) !== opts.length + 1) break;
    const label = parts[i + 1].split(/[,.]/)[0].trim().split(/\s+/).slice(0, 4).join(' ');
    if (label.length < 2) break;
    opts.push('ל' + label + ' הקש ' + parts[i]);
  }
  if (opts.length < 2) return t;
  return (intro ? intro.replace(/[,:]\s*$/, '') + '. ' : '') + opts.join(', ') + '. אפשר גם לומר את המספר.';
}
const FRUSTRATED = /(?:כבר אמרתי|אמרתי לך|אמרתי כבר|לא הבנת|את לא מבינה|לא מבינה אותי|למה את מתבלבלת|התבלבלת|לא זה|לא לזה|לא התכוונתי|לא ביקשתי|שוב פעם|עוד פעם אני|כמה פעמים|10 פעמים|עשר פעמים|תני לי לבחור|תפריט|במקשים)/u;
function words(t) { return new Set(String(t || '').replace(/[^\u0590-\u05FFa-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2)); }
function similar(a, b) { const A = words(a), B = words(b); if (A.size < 2 || B.size < 2) return false; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size) >= 0.6; }
export function isStuck(utterance, current = []) {
  if (FRUSTRATED.test(String(utterance || ''))) return true;
  const recent = (current || []).slice(-3).map(t => t.user);
  return recent.filter(u => similar(u, utterance)).length >= 2;
}

const noThinking = t => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
export function extractAnswer(raw) {
  const s = noThinking(raw);
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]); if (typeof j.answer === 'string' && j.answer.trim()) return j.answer.trim(); } catch {} }
  const loose = s.match(/"answer"\s*:\s*"([\s\S]*?)"\s*}?\s*$/);
  if (loose) return loose[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
  return s.replace(/^```(?:json)?|```$/g, '').trim();
}
// Weak models sometimes slip a Chinese or Cyrillic word into Hebrew.
function cleanScript(t) { return String(t || '').replace(/[\u3000-\u9fff\uac00-\ud7af\u0400-\u04ff]+/g, '').replace(/\s{2,}/g, ' ').trim(); }

// Words that mean "the next step" in a lesson.
function looksLikeLessonRequest(text) {
  return /(?:ללמוד|תלמד|תלמדי|שיעור|מורה|תסביר לי מאפס|מההתחלה)/u.test(String(text || ''));
}
function lessonTopic(text) {
  const t = String(text || '');
  if (/(?:תכנות|תיכנות|קוד|פייתון|python|מתכנת)/iu.test(t)) return 'תכנות';
  if (/(?:אנגלית|english)/iu.test(t)) return 'אנגלית';
  const m = t.match(/ללמוד\s+(?:על\s+)?([֐-׿\w ]{2,30})/u);
  return m ? m[1].trim() : '';
}

// ---------- reliable sources ----------
// Official and well-kept sites first; the caller hears which one was trusted.
const OFFICIAL = /(?:\.gov\.il|clalit\.co\.il|maccabi4u\.co\.il|meuhedet\.co\.il|leumit\.co\.il|boi\.org\.il|cbs\.gov\.il|knesset\.gov\.il|israelpost\.co\.il|rail\.co\.il|egged\.co\.il|ims\.gov\.il|mot\.gov\.il|police\.gov\.il|mda\.org\.il|superpharm\.co\.il|shufersal\.co\.il|rami-levy\.co\.il|wikipedia\.org)/i;
const NEWS = /(?:ynet\.co\.il|kan\.org\.il|mako\.co\.il|walla\.co\.il|maariv\.co\.il|haaretz\.co\.il|globes\.co\.il|calcalist\.co\.il|bhol\.co\.il|kikar\.co\.il|hidabroot\.org|jdn\.co\.il|inn\.co\.il|reuters\.com|apnews\.com|bbc\.)/i;
const WEAK = /(?:facebook\.com|instagram\.com|tiktok\.com|pinterest\.|quora\.com|answers\.|forum|tapatalk|reddit\.com|x\.com|twitter\.com)/i;
export function sourceRank(url) { const u = String(url || ''); return OFFICIAL.test(u) ? 0 : NEWS.test(u) ? 1 : WEAK.test(u) ? 3 : 2; }
function hostOf(url) { return String(url || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, ''); }

// The text of articles being read in this server, so "continue" goes on from
// exactly the same text (a second read may extract the page differently).
const articleCache = new Map();
function cacheArticle(url, text) { articleCache.delete(url); articleCache.set(url, text); while (articleCache.size > 40) articleCache.delete(articleCache.keys().next().value); }
// ---------- songs already downloaded ----------
const LIB_STOP = new Set(['של', 'את', 'לי', 'שיר', 'השיר', 'סרטון', 'הסרטון', 'בבקשה', 'קליפ', 'רשמי', 'official', 'video', 'music', 'prod', 'by', 'the']);
const libWords = t => String(t || '').toLowerCase().replace(/[^\u0590-\u05FFa-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !LIB_STOP.has(w));
// The downloaded song whose title carries (almost) all the words he said.
export function libraryMatch(lib, text) {
  const q = libWords(text);
  if (!q.length) return null;
  let best = null, bestScore = 0;
  for (const item of lib || []) {
    const t = libWords(item.title).join(' ');
    const score = q.filter(w => t.includes(w)).length / q.length;
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return bestScore >= 0.75 ? best : null;
}
const AGAIN = /(?:שוב|מחדש|עוד פעם להוריד|הורדה חדשה|להוריד שוב|תוריד שוב|תורידי שוב)/u;
// 15.11: "download it" means a new download, never the saved copy.
const WANTS_DOWNLOAD = /(?:תוריד|תורידי|להוריד|תורד|הורדה|תעשי הורדה|תעשה הורדה)/u;
function wordSim(a, b) {
  if (a === b) return 1;
  const n = a.length, m = b.length; if (!n || !m) return 0;
  const d = Array.from({ length: n + 1 }, (_, i) => [i, ...Array(m).fill(0)]);
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[n][m] / Math.max(n, m);
}
// A saved song whose name only partly matches what he said (some words, or
// words the phone heard a little wrong): asked about, never played on a guess.
export function libraryNear(lib, text) {
  const q = libWords(text);
  if (!q.length) return null;
  let best = null, bestScore = 0, bestStrong = 0;
  for (const item of lib || []) {
    const t = libWords(item.title);
    if (!t.length) continue;
    let sum = 0, strong = 0;
    for (const w of q) {
      const sim = Math.max(...t.map(x => (x.includes(w) || w.includes(x)) && Math.min(x.length, w.length) >= 3 ? 0.95 : wordSim(w, x)));
      if (sim >= 0.8) { sum += 1; if (w.length >= 3) strong++; } else if (sim >= 0.6) sum += 0.5;
    }
    const score = sum / q.length;
    if (score > bestScore || (score === bestScore && strong > bestStrong)) { best = item; bestScore = score; bestStrong = strong; }
  }
  return best && bestStrong >= 1 && bestScore >= 0.45 ? best : null;
}
export function libraryAsk(item, query) {
  return {
    ref: { type: 'video', videoId: item.videoId, title: item.title },
    choices: { '1': { type: 'play', item }, '2': { type: 'search', query: String(query || '').slice(0, 120) } },
    reply: 'יש אצלך במערכת שיר בשם ' + clip(cleanTitle(item.title), 140) + '. התכוונת אליו? להשמעה מיד, בלי הורדה, הקש 1. אם התכוונת לשיר אחר, הקש 2 ואחפש אותו ביוטיוב.'
  };
}

export function activeArticle(current = []) {
  for (let i = (current || []).length - 1; i >= Math.max(0, current.length - 3); i--) if (current[i]?.ref?.type === 'article') return current[i].ref;
  return null;
}
// About 1,800 characters, ending on a sentence.
export function articleChunk(text, from = 0, size = 1800) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (from >= t.length) return { part: '', next: t.length, done: true };
  let end = Math.min(t.length, from + size);
  if (end < t.length) { const dot = t.lastIndexOf('.', end); if (dot > from + size * 0.5) end = dot + 1; }
  return { part: t.slice(from, end).trim(), next: end, done: end >= t.length };
}
// Where an article page stops being the article (player menus, "more articles", comments).
const ARTICLE_END = /(?:תגיות ועדכונים|תגיות:|subtitles settings|Text Color|Beginning of dialog window|כתבות נוספות|עוד כתבות|עוד בנושא|כתבות קשורות|מומלצים|הכי נקראים|תגובות הגולשים|הוסיפו תגובה|הוספת תגובה|לכל הכתבות|שתפו את הכתבה|קראו עוד)/i;
function readableArticle(text) {
  let t = String(text || '');
  const cut = t.search(ARTICLE_END);
  if (cut > 400) t = t.slice(0, cut);
  return t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ')
    .split(/\n+/).filter((l, i, all) => all.indexOf(l) === i).filter(l => l.trim().length > 40 && !l.split(/\s+/).some(w => w.length > 24) && !/(?:cookie|קוקיז|הרשמה לניוזלטר|כל הזכויות שמורות|תגובות|שתפו|share|לחצו כאן)/i.test(l)).join('\n');
}

/**
 * One full extension-3 turn. Returns { reply, intent, ref?, confirm?, mediaStatus?, cancel?, instruction? }.
 * deps: llm(prompt,{budgetMs,maxTokens,planner}) -> text
 *       webSearch(query,{timeoutMs}) -> [{title,url,snippet}]
 *       readPages(urls,{timeoutMs}) -> [{url,title,content}]
 *       findVideos(queries, opts) (defaults to the real one above)
 *       log
 */
export async function ext3Turn(input, deps) {
  const r = await ext3TurnInner(input, deps);
  return input.voice === 'male' && r && r.reply ? { ...r, reply: toMaleSelf(r.reply) } : r;
}
async function ext3TurnInner({ utterance, summary = '', prior = [], current = [], now = '', prefs = [], media = '', voice = 'female', brief = false }, deps) {
  const log = deps.log || console;
  const lastVideo = activeVideo(current, prior);
  // "It / this one" is what was just talked about: the video of the last two
  // turns, or an earlier one only when he points back at it ("שמצאת", "לפני כן").
  // 11.11: "תורידי לי את השיר הזה" meant a song from a web answer, and an old
  // gospel video was offered again and again.
  const lastVideoAge = (() => { for (let i = current.length - 1; i >= 0; i--) if (current[i]?.ref?.type === 'video') return current.length - 1 - i; return Infinity; })();
  const backref = BACKREF.test(utterance);
  let video = lastVideo && (lastVideoAge <= 1 || backref) ? lastVideo : null;
  // "the second one" from the options read to him.
  const picked = ordinalOption(utterance, lastVideo?.options);
  if (picked && lastVideoAge <= 2) video = picked;
  const lessonRef = activeLesson(current);
  const article = activeArticle(current);
  const context = buildContext({ summary, prior, current, maxChars: 5200 });
  const smallContext = buildContext({ summary, prior, current, maxChars: 2600 });
  const stuck = isStuck(utterance, current);
  let plan = null;
  const t0 = Date.now();
  const rules = heuristicPlan(utterance, { video });
  if (picked && rules.intent === 'video_play') rules.ytHe = '';
  const continuing = /^(?:כן|תמשיכי|תמשיך|המשיכי|המשך|הלאה|נמשיך|עוד)(?=$|[\s,.!?])/u.test(utterance.trim());
  const sure = !stuck && (styleRequest(utterance) || rules.continueOffer || ['media_status', 'cancel', 'library'].includes(rules.intent) || (rules.intent === 'video_play' && /^בחרתי באפשרות/u.test(utterance)) || (video && ['video_play', 'video_about'].includes(rules.intent) && !rules.ytHe));
  if (article && continuing) plan = { ...rules, intent: 'read_page', continueOffer: true };
  else if (sure) plan = rules;
  else try {
    plan = parsePlan(await deps.llm(plannerPrompt({ context: smallContext, utterance, now, video, older: video ? null : lastVideo, media, prefs }), { budgetMs: Number(deps.plannerBudgetMs || 3200), maxTokens: 450, planner: true }));
  } catch (e) { log.warn?.('[EXT3_BRAIN] planner unavailable; using rules', { status: e?.status || 0 }); }
  if (!plan) {
    plan = rules;
    // No planner and nothing recent: "play it" still means the last video of the call.
    if (!video && lastVideo && rules.intent === 'video_play' && !rules.ytHe) video = lastVideo;
  }
  // A song or video to find stays a YouTube search even when the planner
  // called it a web question (12.11: "a new song by Shwekey" got a web answer).
  if (rules.intent === 'video_find' && ['web', 'chat'].includes(plan.intent)) plan = { ...plan, intent: 'video_find', ytHe: plan.ytHe || rules.ytHe, recentDays: plan.recentDays || rules.recentDays };
  // A halachic time or "the nearest X" is computed from the map even when the
  // planner called it a web question; his own place words fill what it left out.
  if (['zmanim', 'nearby'].includes(rules.intent) && ['web', 'chat', 'recall'].includes(plan.intent)) plan = { ...plan, intent: rules.intent };
  // 19.11 (owner): a question about what the system can do is answered from
  // the system's real facts; no search, no download, whatever words it holds.
  if (isCapabilityQuestion(utterance)) { plan = { ...plan, intent: 'chat', about: true }; log.info?.('[EXT3_BRAIN] question about the system'); }
  // 18.11 "מה נשמע כפרה" was searched on the web and explained like a dictionary.
  if (GREETING.test(utterance.trim()) && ['web', 'read_page', 'recall'].includes(plan.intent)) plan = { ...plan, intent: 'chat' };
  // Facts about real people, songs and routes come from the web, never from a
  // small model's memory (17.11: an invented duo "אישואשה", invented albums,
  // invented bus lines through Ramat Gan).
  if (plan.intent === 'chat' && !plan.about && !plan.continueOffer && !lessonRef && FACTUAL.test(utterance + ' ' + plan.standalone)) { plan = { ...plan, intent: 'web', search: plan.search || plan.standalone || utterance }; log.info?.('[EXT3_BRAIN] factual question sent to the web'); }
  // "Cancel" only means stopping a download that exists (17.11: "תפסיקי למצוא
  // סרטונים באנגלית" and "תורידי לי את כל השירים" were both answered
  // "בסדר, אני לא מורידה כלום").
  if (plan.intent === 'cancel' && !/(?:תבטל|תבטלי|לבטל|ביטול|תעצור|תעצרי|עצור|עצרי|אל תוריד|לא רוצה (?:ש)?(?:ת)?וריד|לא להוריד|תפסיקי? (?:את )?ה?הורדה|תפסיקי? להוריד)/u.test(utterance))
    plan = { ...plan, intent: PLAY_WORD.test(utterance) ? 'video_play' : 'chat' };
  if (['zmanim', 'nearby'].includes(plan.intent)) {
    if (!plan.place && !plan.town) { plan.place = rules.place || ''; plan.town = rules.town || ''; }
    if (plan.intent === 'nearby' && !nearbyKind(plan.kind || '')) plan.kind = rules.kind || nearbyKind(utterance + ' ' + plan.standalone)?.label || plan.kind || '';
  }
  // A standing instruction said in plain words is kept even when the planner missed it.
  // Only when he really said a standing rule (the planner sometimes fills the
  // field with a description of the request).
  const ruleWords = /(?:אל תדברי|אל תדבר|תפסיקי לדבר|תפסיק לדבר|אל תספרי|אל תזכירי|אני לא רוצה שתדברי|אני לא רוצה שתזכירי|מעכשיו|מהיום והלאה|מהיום ת|תמיד ת|אף פעם אל|אף פעם לא|תזכרי ש|תזכור ש|בפעם הבאה ש|תדברי איתי ב|תדברי אליי ב|תפני אליי|תפסיקי ל|תפסיק ל|אל תמצאי|אל תביאי|אל תמליצי|אל תציעי)/u.test(utterance);
  const styleAsk = styleRequest(utterance);
  if (styleAsk) {
    plan.intent = 'chat';
    if (styleAsk.reset) return { intent: 'chat', styleReset: true, reply: 'בסדר, חזרתי לדבר איתך רגיל. על מה נדבר?' };
    const shortStyle = styleAsk.style.split(':')[0];
    return { intent: 'chat', instruction: STYLE_PREFIX + styleAsk.style, reply: /עוקצני/u.test(shortStyle)
      ? 'אוקיי, ביקשת עוקצנית? קיבלת. רק שלא תתלונן אחר כך. כשתתגעגע לגרסה הנחמדה שלי, פשוט תגיד דברי רגיל.'
      : 'בסדר, מעכשיו אדבר איתך ' + (styleAsk.own ? 'בסגנון של ' + styleAsk.own : shortStyle) + '. כשתרצה לחזור לרגיל, פשוט תגיד דברי רגיל.' };
  }
  if (!ruleWords) plan.instruction = '';
  else {
    if (!plan.instruction) plan.instruction = utterance.trim().slice(0, 200);
    // "From now on don't talk about X" is a rule, not a cancel or a search.
    if (['cancel', 'media_status'].includes(plan.intent) || (plan.intent === 'web' && !/(?:תחפשי|תחפש|באינטרנט|ברשת)/u.test(utterance))) plan.intent = 'chat';
  }
  if ((plan.intent === 'video_find' || plan.intent === 'video_play') && !plan.minMinutes && /(?:ארוך|ארוכה|ארוכים|מלא|שעה)/u.test(utterance)) plan.minMinutes = /שעה/u.test(utterance) ? 40 : 20;
  if ((plan.intent === 'video_find' || plan.intent === 'video_play') && !plan.maxMinutes && /(?:שיר בודד|סינגל|שיר אחד|לא סט|בלי סט|לא רוצה סט)/u.test(utterance)) plan.maxMinutes = 8;
  // "The newest / the latest episode": newest first among the real matches, with
  // no date cut-off (a show's last full episode can be months old).
  if ((plan.intent === 'video_find' || plan.intent === 'video_play') && NEWEST.test(utterance)) { plan.order = 'date'; plan.recentDays = 0; }
  if (!video && plan.intent === 'video_about') plan.intent = 'recall';
  // "The episode you said you found" is the one found before, not a new search
  // (12.11 22:11: he asked for it three times and got "not found").
  if (video && plan.intent === 'video_find' && !PLAY_WORD.test(utterance) && /(?:ש(?:אמרת|מצאת|הצעת|המלצת|אמרתי)|לפני כן|מקודם)(?![\u0590-\u05FF])/u.test(utterance))
    return { intent: 'video_about', ref: video, reply: 'הסרטון שמצאתי לך קודם הוא ' + video.title + (video.channelTitle ? ', בערוץ ' + video.channelTitle : '') + (video.durationSec ? ', אורכו ' + spokenDuration(video.durationSec) : '') + '. אם תרצה לשמוע או להוריד אותו, אמור תשמיעי לי אותו.' };
  // A video download only when the caller said so.
  plan.play = /(?:להוריד|תוריד|תורידי|הורד|הורדה|הורדת).{0,25}(?:וידאו|וידיאו|ווידאו|סרטון עצמו|הסרטון)|(?:וידאו|וידיאו|ווידאו).{0,15}(?:להוריד|תוריד|תורידי)|כן לוידאו/u.test(utterance) ? 'video' : 'audio';
  log.info?.('[EXT3_BRAIN] plan', { intent: plan.intent, standalone: plan.standalone.slice(0, 140), search: plan.search.slice(0, 100), yt: plan.ytHe.slice(0, 80), stuck, instruction: !!plan.instruction, ms: Date.now() - t0 });
  const out = extra => ({ intent: plan.intent, ...(plan.instruction ? { instruction: plan.instruction } : {}), ...extra });

  // Sources leave less room for the conversation: the whole request must stay
  // small enough for the free fast models (they refuse big ones with 413).
  const ask = async (instruction, extra = '', { maxTokens = 1800, budgetMs = 13000, lesson = lessonRef, ctx = context } = {}) => {
    let raw;
    const common = { utterance, plan, now, instruction, lesson, prefs, media, stuck, voice, brief, compliment: voice !== 'male' && !brief && !stuck && (current || []).length % 4 === 2, tip: !stuck && !plan.about && (current || []).length % 3 === 1 };
    if (brief && !/(?:בהרחבה|בפירוט|תפרט|תרחיב|לעומק|באריכות)/u.test(utterance)) maxTokens = Math.min(maxTokens, 700);
    try { raw = await deps.llm(answerPrompt({ ...common, context: ctx, extra }), { budgetMs, maxTokens }); }
    catch (e) {
      // Every model busy (free per-minute limits): one more try, smaller, a moment later.
      log.warn?.('[EXT3_BRAIN] answer models busy; one smaller retry', { status: e?.status || 0 });
      await new Promise(r => setTimeout(r, deps.retryPauseMs ?? 3000));
      raw = await deps.llm(answerPrompt({ ...common, context: smallContext.slice(-1500), extra: String(extra || '').slice(0, 3000) }), { budgetMs: 10000, maxTokens: Math.min(maxTokens, 1000) });
    }
    const a = cutStockOpening(cleanScript(extractAnswer(raw).replace(/^\s*answer\s*[:¶,.\-]?\s*/i, '')));
    if (!a) throw Object.assign(new Error('empty answer'), { status: 502 });
    return a;
  };

  if (plan.intent === 'media_status') return out({ mediaStatus: true, reply: '' });
  // "Download them all": one at a time, and he picks which one first.
  if (['video_play', 'cancel'].includes(plan.intent) && /(?:את כל|את כולם|הכל|כל השירים|כל הסרטונים|כולם)(?=$|[\s,.!?])/u.test(utterance) && PLAY_WORD.test(utterance)) {
    const opts = (lastVideo?.options || []).slice(0, 3);
    const choices = {}; opts.forEach((v, i) => { choices[String(i + 1)] = { type: 'video', video: v }; });
    return out({ ...(opts.length ? { choices } : {}), reply: 'אני מורידה שיר או סרטון אחד בכל פעם, כדי שתשמע בדיוק מה יורד ותאשר. ' +
      (opts.length ? 'נתחיל באחד מהם: ' + opts.map((v, i) => 'ל' + clip(cleanTitle(v.title), 55) + ' הקש ' + (i + 1)).join(', ') + '. אחרי שהוא יורד, נעבור לבא בתור.' : 'אמור לי את שם השיר הראשון שתרצה, ואחריו נמשיך לבא.') });
  }
  if (plan.intent === 'cancel') return out({ cancel: true, reply: '' });

  if (plan.intent === 'library') {
    const lib = deps.library ? await deps.library().catch(() => []) : [];
    if (!lib.length) return out({ reply: 'עוד לא מצאתי שירים שהורדו ושמורים במערכת. אפשר לבקש ממני שיר או סרטון, ואמצא ואוריד אותו בשבילך.' });
    const recent = [...lib].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
    const choices = {};
    recent.forEach((x, i) => { choices[String(i + 1)] = { type: 'play', item: x }; });
    return out({ choices, reply: 'יש אצלך במערכת ' + lib.length + ' שירים וקבצים שכבר הורדו, והם מתנגנים מיד בלי הורדה נוספת. האחרונים שהורדו: ' +
      recent.map((x, i) => 'לשמיעת ' + clip(cleanTitle(x.title), 60) + ' הקש ' + (i + 1)).join(', ') + '. אפשר גם לבקש כל שיר אחר בשמו.' });
  }

  if (plan.intent === 'video_play') {
    // Already downloaded? Then it plays now, with no new download (unless he
    // asked to download it again).
    const lib = deps.library && !AGAIN.test(utterance) && !WANTS_DOWNLOAD.test(utterance) ? await deps.library().catch(() => []) : [];
    const fromLib = item => out({ ref: { type: 'video', videoId: item.videoId, title: item.title }, play: { paths: [item.path], durationSec: 0, title: item.title },
      reply: clip(cleanTitle(item.title), 140) + ' כבר שמור אצלך במערכת, אז לא צריך להוריד אותו שוב. משמיעה אותו עכשיו.' });
    if (lib.length) {
      const pointsAtItEarly = (/(?:אותו|אותה|הזה|הזאת|את זה|שלו|שלה|שהמלצת|שאמרת|שדיברנו|שמצאת)/u.test(utterance) || BACKREF.test(utterance));
      const ownName = !pointsAtItEarly && rules.intent === 'video_play' && rules.ytHe && rules.ytHe.length >= 3 ? rules.ytHe : (plan.ytHe || '');
      const hit = (video && (pointsAtItEarly || !ownName) && lib.find(x => x.videoId === video.videoId)) || (ownName && libraryMatch(lib, ownName));
      // He said only a small part of its name (one word of "אושר כהן - דאון"):
      // asked first, not played on a guess (15.11).
      const covers = (item, said) => { const t = libWords(item.title), q = libWords(said); return t.length ? t.filter(w => q.some(x => x.includes(w) || w.includes(x))).length / t.length : 1; };
      if (hit && ownName && !pointsAtItEarly && !(video && hit.videoId === video.videoId) && covers(hit, ownName) < 0.5 && !/ביוטיוב/u.test(utterance)) return out(libraryAsk(hit, ownName));
      if (hit) return fromLib(hit);
      // Only part of the name matched a saved song: ask before playing it.
      const said = ownName || (plan.ytHe && plan.ytHe.length >= 3 ? plan.ytHe : '');
      const near = said && !pointsAtItEarly && !/ביוטיוב/u.test(utterance) ? libraryNear(lib, said) : null;
      if (near) return out(libraryAsk(near, said));
    }
    // Which video: the one on record when he points at it, otherwise the one he
    // names (searched by name, never by the whole sentence). Nothing is
    // downloaded here: he hears the full title first and chooses with a key.
    let v = null;
    const pointsAtIt = (/(?:אותו|אותה|הזה|הזאת|את זה|שלו|שלה|שהמלצת|שאמרת|שדיברנו|שמצאת)/u.test(utterance) || BACKREF.test(utterance));
    // His own words name the target first (the planner sometimes fills in the
    // video already on record instead of the new name he said).
    const ownName = !pointsAtIt && rules.intent === 'video_play' && rules.ytHe && rules.ytHe.length >= 3 ? rules.ytHe : '';
    const named = ownName || (plan.ytHe && plan.ytHe.length >= 3 ? plan.ytHe : '');
    const overlap = (a, b) => { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return A.size ? n / A.size : 0; };
    // The old video only when every word he said is in its title ("אושר כהן דאון" is not "אושר כהן - אין אותי").
    if (video && (!named || pointsAtIt || overlap(named, video.title) >= 0.85)) v = video;
    else if (named) {
      let found = await (deps.findVideos || findVideos)([named, plan.ytEn], { minMinutes: plan.minMinutes, maxMinutes: plan.maxMinutes, order: plan.order === 'date' ? 'date' : 'relevance', env: deps.env, fetchImpl: deps.fetchImpl, proxy: deps.youtubeProxy }).catch(() => []);
      if (!found.length && plan.minMinutes) found = await (deps.findVideos || findVideos)([named, plan.ytEn], { maxMinutes: plan.maxMinutes, order: plan.order === 'date' ? 'date' : 'relevance', env: deps.env, fetchImpl: deps.fetchImpl, proxy: deps.youtubeProxy }).catch(() => []);
      if (found[0]) v = videoRef(found[0]);
    }
    const inLib = v && lib.find(x => x.videoId === v.videoId);
    if (inLib) return fromLib(inLib);
    if (!v) return out({ reply: 'עוד לא בחרנו סרטון מסוים. ספר לי את שם השיר או הסרטון שאתה רוצה, ואמצא לך אותו ביוטיוב.' });
    return out({ ref: v, ...confirmFor(v, plan.play) });
  }

  if (plan.intent === 'video_find') {
    const queries = [plan.ytHe || plan.standalone || utterance, plan.ytEn].filter(Boolean);
    // Not the same video again (he said he already heard it), unless he asks for it.
    const seenIds = [...current, ...prior].map(t => t?.ref?.type === 'video' ? t.ref.videoId : null).filter(Boolean);
    let found = [];
    try { found = await (deps.findVideos || findVideos)(queries, { minMinutes: plan.minMinutes, maxMinutes: plan.maxMinutes, recentDays: plan.recentDays, order: plan.order, exclude: seenIds, env: deps.env, fetchImpl: deps.fetchImpl, proxy: deps.youtubeProxy }); }
    catch (e) { log.warn?.('[EXT3_BRAIN] YouTube search failed', { status: e?.status || 0, message: String(e?.message || e).slice(0, 120) }); }
    if (!found.length && plan.recentDays) {
      try { found = await (deps.findVideos || findVideos)(queries, { minMinutes: plan.minMinutes, maxMinutes: plan.maxMinutes, recentDays: Math.max(60, plan.recentDays * 4), order: plan.order, exclude: seenIds, env: deps.env, fetchImpl: deps.fetchImpl, proxy: deps.youtubeProxy }); } catch {}
    }
    // Step by step, each looser than the one before, until something real is found:
    // the planner's words, then his own words cleaned, without the length, without the date.
    const search = (qq, o) => (deps.findVideos || findVideos)(qq, { minMinutes: plan.minMinutes, maxMinutes: plan.maxMinutes, recentDays: plan.recentDays, order: plan.order, exclude: seenIds, env: deps.env, fetchImpl: deps.fetchImpl, proxy: deps.youtubeProxy, ...o }).catch(() => []);
    let relaxed = '';
    const own = ytSubject(utterance);
    if (!found.length && own && own !== ytSubject(queries[0])) found = await search([own, plan.ytEn].filter(Boolean), {});
    if (!found.length && plan.minMinutes) { found = await search([own || queries[0], ...queries].slice(0, 3), { minMinutes: 0, recentDays: 0 }); if (found.length) relaxed = 'length'; }
    if (!found.length && plan.recentDays) { found = await search(queries, { recentDays: 0 }); if (found.length) relaxed = 'date'; }
    // 17.11: "סט שירים חדש" brought Chinese dramas and art-supply videos.
    // A Hebrew request keeps Hebrew results unless he asked for another language.
    if (found.length && /[\u0590-\u05FF]/.test(queries[0]) && !/(?:באנגלית|בערבית|ברוסית|בצרפתית|לועזי|בשפה זרה|english)/iu.test(utterance)) {
      const heb = found.filter(v => /[\u0590-\u05FF]/.test(v.title + ' ' + v.channelTitle));
      if (heb.length) found = heb.concat(found.filter(v => !heb.includes(v) && /(?:israel|hebrew|jewish|mizrahi|ישראל)/i.test(v.title + ' ' + v.description))).slice(0, 10);
    }
    // "סט" means a long mix, not a 1-minute short.
    if (found.length && /(?:^|\s)(?:סט|מחרוזת|מיקס|ברצף|רצף)(?=$|\s)/u.test(utterance) && !plan.maxMinutes) { const long = found.filter(v => v.durationSec >= 15 * 60); if (long.length) found = long; }
    if (!found.length) return out({ reply: 'חיפשתי ביוטיוב את ' + (own || queries[0]) + ' בכמה דרכים, ולא מצאתי סרטון שמתאים למה שביקשת. ייתכן שזה פשוט לא עלה ליוטיוב. אפשר לומר לי את השם בצורה אחרת, למשל שם הערוץ או שם הפרק, ואחפש שוב.' });
    const instruction = 'המתקשר ביקש המלצה על סרטון. לפניך רשימת סרטונים אמיתיים שנמצאו עכשיו ביוטיוב, עם הכותרת המדויקת, הערוץ, האורך בדקות, מספר הצפיות, תאריך הפרסום והתיאור. ' +
      'בחרי את הסרטון המתאים ביותר לבקשה: קודם שיתאים בדיוק לנושא, לסוג (שיר בודד, סט, הרצאה), לשפה, לאורך ולמידת החדשות שביקש, ובין המתאימים עדיף סרטון איכותי ופופולרי. אסור להמליץ על סרטון שאינו ברשימה, ואסור לשנות את הכותרת, הערוץ, האורך או התאריך. ' +
      'דברי במשפטים טבעיים וזורמים, כמו שמספרים לחבר ("מצאתי לך את..., זה מהערוץ של..., אורכו..."), ולא כטופס עם מילים כמו "כותרת:" או "ערוץ:". בתשובה אמרי את הכותרת המדויקת כפי שהיא (ואם היא בשפה זרה גם תרגום לעברית), את שם הערוץ, את האורך, מתי פורסם ואת מספר הצפיות, ותארי בעברית במילים שלך על מה הסרטון רק לפי התיאור שלו, בלי להמציא. ' +
      (relaxed === 'length' ? 'חשוב: לא נמצא ביוטיוב סרטון באורך מלא כפי שביקש. אמרי לו זאת בכנות במשפט אחד (ייתכן שהפרקים המלאים לא עולים ליוטיוב), והציעי את הקרוב ביותר מהרשימה. ' : '') +
      'אם הסרטונים שנמצאו אינם התוכנית או השיר עצמו אלא פודקאסט, ראיון, כתבה או קטע על הנושא, אמרי זאת בכנות במשפט אחד ("פרק מלא של התוכנית עצמה לא מצאתי ביוטיוב, אבל יש..."). ' +
      (plan.order === 'date' ? 'הוא ביקש את החדש ביותר: הרשימה ממוינת מהחדש לישן, אז עדיף את הראשון שמתאים לנושא, ואמרי מתי פורסם. ' : '') +
      'סיימי בכך שאפשר לומר "תשמיעי לי אותו" כדי לשמוע או להוריד אותו. ' +
      'החזר JSON בלבד בצורה {"pick":מספר i של הסרטון הנבחר,"answer":"התשובה למתקשר"}.';
    let pick = 0, reply = '';
    try {
      const raw = await deps.llm(answerPrompt({ context: smallContext, utterance, plan, now, instruction, prefs, voice, brief, extra: 'סרטונים שנמצאו:\n' + candidatesText(found.slice(0, plan.order === 'date' ? 3 : 8)) }), { budgetMs: 12000, maxTokens: 1400 });
      const m = noThinking(raw).match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : null;
      if (Number.isInteger(j?.pick) && found[j.pick]) pick = j.pick;
      reply = cutStockOpening(String(j?.answer || '').trim());
    } catch (e) { log.warn?.('[EXT3_BRAIN] video pick unavailable; using the top result', { status: e?.status || 0 }); }
    // No pick from the model: the most watched of the top results, not just the first.
    if (!reply && found.length > 1) pick = found.slice(0, 5).reduce((b, x, i) => (Number(x.viewCount) || 0) > (Number(found[b].viewCount) || 0) ? i : b, 0);
    const v = found[pick];
    if (!reply || !reply.includes(v.title.slice(0, Math.min(20, v.title.length)))) {
      reply = 'מצאתי לך ביוטיוב את הסרטון ' + v.title + ', בערוץ ' + v.channelTitle + '. אורכו ' + spokenDuration(v.durationSec) + (spokenViews(v.viewCount) ? ', ויש לו ' + spokenViews(v.viewCount) : '') + '. ' +
        (v.description && !/(?:@|www|\.com|טלפון|הופעות|יחסי ציבור|אינסטגרם|פייסבוק|instagram|facebook|ניהול|הזמנות|לפרטים)/i.test(clip(v.description, 220)) ? 'לפי התיאור שלו: ' + clip(v.description, 220) + ' ' : '') +
        'אם תרצה לשמוע או להוריד אותו, אמור תשמיעי לי אותו.';
    }
    // The other good options, by key: pressing one says its full title and asks before any download.
    const others = found.filter((x, i) => i !== pick).slice(0, 2);
    const choices = {};
    if (others.length) {
      [v, ...others].forEach((x, i) => { choices[String(i + 1)] = { type: 'video', video: videoRef(x) }; });
      reply = reply.replace(/[.\s]*$/, '. ') + 'ואם תרצה לבחור במקשים: ' + [v, ...others].map((x, i) => 'ל' + clip(cleanTitle(x.title), 55) + ' הקש ' + (i + 1)).join(', ') + '.';
    }
    return out({ ref: { ...videoRef(v), ...(others.length ? { options: [v, ...others].map(videoRef) } : {}) }, reply, ...(others.length ? { choices } : {}) });
  }

  if (plan.intent === 'video_about' && video) {
    const facts = 'פרטי הסרטון האמיתיים (מיוטיוב): כותרת מדויקת: "' + video.title + '". ערוץ: ' + (video.channelTitle || 'לא ידוע') + '. אורך: ' + (spokenDuration(video.durationSec) || 'לא ידוע') +
      '. צפיות: ' + (video.viewCount || 'לא ידוע') + '. פורסם: ' + String(video.publishedAt || '').slice(0, 10) + '. שפה: ' + (video.language || 'לא ידוע') + '.' + (deps.videoDescription ? ' תיאור: ' + clip(cleanDescription(await deps.videoDescription(video.videoId).catch(() => '')), 700) : '');
    const reply = await ask('המתקשר שואל על הסרטון שכבר הוזכר. ענה רק מתוך הפרטים האמיתיים שלמטה. כשמבקשים את השם: אמרי את הכותרת המדויקת כפי שהיא, ואם היא בשפה זרה גם תרגום מדויק לעברית, ואם מבקשים לאיית או להגיד לאט, אמרי אותה מילה אחר מילה. אל תמציאי תוכן שלא מופיע בתיאור.', facts, { maxTokens: 900, budgetMs: 9000 });
    return out({ ref: video, reply });
  }

  if (plan.intent === 'read_page') {
    // Continue the article already being read, or find the one he asked for.
    let url = article?.url || '', title = article?.title || '', from = article && plan.continueOffer ? Number(article.pos) || 0 : 0;
    let text = '';
    if (!article || !plan.continueOffer) {
      const q = plan.search || plan.standalone || utterance;
      const site = /(?:הידברות|hidabroot)/i.test(q + utterance) ? 'hidabroot.org' : /(?:ynet|וויינט|ווינט)/i.test(q + utterance) ? 'ynet.co.il' : /(?:כיכר השבת|kikar)/i.test(q + utterance) ? 'kikar.co.il' : /(?:בחדרי חרדים|bhol)/i.test(q + utterance) ? 'bhol.co.il' : '';
      let topic = q.replace(/(?:תקריאי|תקריא|לי|כתבה|מאמר|מאתר|באתר|מהאתר|הידברות|ynet|כיכר השבת|בחדרי חרדים|את)/giu, ' ').replace(/\s+/g, ' ').trim();
      // A generic wish ("something uplifting") becomes a real topic to search for.
      if (!topic || /^(?:מחזקת|מחזק|מעניינת|מעניין|טובה|יפה|חדשה|נחמדה)$/u.test(topic)) topic = 'כתבה מחזקת על אמונה ובטחון';
      const queries = [...new Set([site ? (topic || 'כתבה') + ' site:' + site : '', site ? (topic || 'כתבה') + ' ' + site.split('.')[0] : '', q].filter(Boolean))];
      const sets = await Promise.allSettled(queries.map(x => deps.webSearch(x, { timeoutMs: 4500 })));
      const seen = new Set();
      // A real article page: on the site he named when he named one, with a
      // deep path (not the home page or a section like "news today").
      const looksLikeArticle = u => { const path = String(u).replace(/^https?:\/\/[^/]+/, ''); return /\d{3,}/.test(path) || path.split('/').filter(Boolean).some(x => x.length > 25); };
      const cands = sets.flatMap(x => x.status === 'fulfilled' ? x.value || [] : []).filter(r => {
        if (!r?.url || seen.has(r.url)) return false; seen.add(r.url);
        return !/(?:youtube|facebook|instagram|tiktok)\./i.test(r.url) && (!site || String(r.url).includes(site)) && looksLikeArticle(r.url);
      }).sort((a, b) => (/\/article\//.test(b.url) ? 1 : 0) - (/\/article\//.test(a.url) ? 1 : 0)).slice(0, 3);
      if (!cands.length) return out({ reply: 'לא מצאתי' + (site ? ' באתר ' + site : '') + ' כתבה מתאימה לקריאה. אפשר לומר לי את שם הכתבה או את הנושא שלה, למשל כתבה על אמונה או על שלום בית, ואחפש שוב.' });
      const pages = deps.readPages ? await Promise.race([deps.readPages(cands.map(c => c.url), { timeoutMs: 7000 }).catch(() => []), new Promise(r => setTimeout(() => r([]), 8000).unref?.())]) : [];
      for (const c of cands) {
        const pg = (pages || []).find(x => String(x.url || '').replace(/[#?].*$/, '') === String(c.url).replace(/[#?].*$/, ''));
        const tx = readableArticle(pg?.content || '');
        // A real article, not a video page with one caption line.
        if (tx.length >= 700) { url = c.url; title = pg?.title || c.title; text = tx; break; }
      }
      if (!text) return out({ reply: 'מצאתי את הכתבה ' + clip(cands[0].title, 120) + ', אבל לא הצלחתי לקרוא את התוכן שלה כרגע. אפשר לנסות שוב בעוד רגע, או לבקש כתבה אחרת.' });
      from = 0;
    } else if (articleCache.has(url)) {
      text = articleCache.get(url);
    } else {
      const pages = deps.readPages ? await Promise.race([deps.readPages([url], { timeoutMs: 7000 }).catch(() => []), new Promise(r => setTimeout(() => r([]), 8000).unref?.())]) : [];
      text = readableArticle(pages[0]?.content || '');
      if (text.length < 200) return out({ ref: article, reply: 'לא הצלחתי לקרוא כרגע את המשך הכתבה ' + clip(title, 120) + '. אפשר לומר תמשיכי שוב בעוד רגע.' });
    }
    cacheArticle(url, text);
    const { part, next, done } = articleChunk(text, from);
    const opening = from === 0 ? 'הנה הכתבה ' + clip(title, 140) + ', מאתר ' + hostOf(url) + '. ' : '';
    return out({
      ref: { type: 'article', url, title: clip(title, 160), pos: next },
      reply: opening + part + (done ? ' זה סוף הכתבה.' : ' להמשך הכתבה אמור תמשיכי.')
    });
  }

  if (plan.intent === 'zmanim') {
    const facts = await within(Number(deps.placeBudgetMs || 11000), (deps.zmanimFacts || realZmanim)({ place: plan.place, town: plan.town, date: plan.date, utterance: utterance + ' ' + plan.standalone }, { fetchImpl: deps.fetchImpl || fetch, log, now: deps.nowDate || new Date() })).catch(e => { log.warn?.('[ZMANIM] failed', String(e?.message || e).slice(0, 100)); return null; });
    if (facts?.unknownPlace) return out({ reply: 'לא מצאתי במפה את המקום ' + facts.unknownPlace + '. ' + 'תוכל' + ' לומר לי את שם היישוב או העיר הקרובה, ואחשב לך את הזמנים בדיוק לפיה?' });
    if (facts) {
      log.info?.('[ZMANIM] computed', { place: facts.loc?.label, town: facts.loc?.town, date: facts.date, source: facts.source, approx: !!facts.loc?.approx });
      const direct = zmanReply(facts, utterance + ' ' + plan.standalone);
      if (direct) return out({ reply: direct });
      const reply = await ask('המתקשר שואל על זמני היום ההלכתיים. לפניך הזמנים המדויקים שחושבו עכשיו בדיוק למקום ולתאריך שעליהם שאל. עני רק לפיהם, בלי לשנות אף זמן ובלי זמנים מהזיכרון: קודם בדיוק מה ששאל, ואם שאל על כל הזמנים, מני את העיקריים לפי הסדר. אמרי את הזמנים במילים בדיוק כפי שהם כתובים (למשל שמונה וארבעים ותשע דקות בבוקר), ואמרי לאיזה מקום וליום החישוב. בסוף משפט קצר שבלוחות שונים יש לפעמים הבדל של דקה או שתיים, ושכדאי לנהוג לפי הלוח והרב של המקום.', facts.text, { maxTokens: 900, budgetMs: 10000, ctx: smallContext })
        .catch(() => 'הנה זמני היום ' + facts.when + ' לפי ' + facts.loc.label + '. ' + facts.text.split('\n').slice(1, 9).map(l => l.replace(/\s*\(\d{1,2}:\d{2}\)/, '')).join('. ') + '.');
      return out({ reply });
    }
    log.warn?.('[ZMANIM] no calculation; falling back to the web');
    plan.intent = 'web'; plan.search = plan.search || plan.standalone || utterance;
  }

  if (plan.intent === 'nearby') {
    const kindText = plan.kind || utterance;
    const [facts, web] = await Promise.all([
      within(Number(deps.placeBudgetMs || 13000), (deps.nearbyFacts || realNearby)({ kindText: kindText + ' ' + utterance, place: plan.place, town: plan.town }, { fetchImpl: deps.fetchImpl || fetch, log })).catch(e => { log.warn?.('[PLACE] nearby failed', String(e?.message || e).slice(0, 100)); return null; }),
      deps.webSearch ? deps.webSearch(plan.search || plan.standalone || utterance, { timeoutMs: 4500 }).catch(() => []) : Promise.resolve([])
    ]);
    if (facts?.unknownPlace && !(web || []).length) return out({ reply: 'לא מצאתי במפה את המקום ' + facts.unknownPlace + '. אפשר לומר לי שם של רחוב או של מקום מוכר לידו, ובאיזו עיר, ואחפש שוב?' });
    if (facts?.items?.length || (web || []).length) {
      log.info?.('[PLACE] nearby', { kind: facts?.kind, place: facts?.loc?.label, town: facts?.loc?.town, found: facts?.items?.length || 0, web: (web || []).length, approx: !!facts?.loc?.approx });
      const webText = (web || []).slice(0, 5).map((r, i) => 'תוצאת חיפוש ' + (i + 1) + ': ' + clip(r.title, 110) + ' (' + hostOf(r.url).slice(0, 40) + ')\n' + clip(r.snippet, 300)).join('\n');
      const reply = await ask('המתקשר שואל איפה יש ' + (facts?.kind || 'מקום') + ' קרוב למקום מסוים. ' +
        (facts?.items?.length ? 'לפניך רשימה מהמפה, ממוינת מהקרוב לרחוק, עם המרחק בקו אווירי והכתובת. התחילי בתשובה ישירה: הקרוב ביותר, שמו, כמה רחוק ובאיזה רחוב, ואיך להגיע אליו בכמה מילים אם הכתובת מאפשרת. אחר כך עוד אחד או שניים קרובים. אם במפה אין לו שם, אמרי שזה ' + facts.kind + ' שמופיע במפה בלי שם, עם הכתובת. ' : 'במפה לא נמצאו תוצאות, ענה רק לפי תוצאות החיפוש. ') +
        'תוצאות החיפוש באינטרנט עוזרות רק כשהן מדברות בבירור על אותו מקום ממש (למשל בית כנסת שנמצא בתוך החוף או צמוד אליו); אל תמציאי מרחקים, כתובות או שמות שלא מופיעים. אם הוא שאל על מקום בעיר מסוימת, אל תציעי מקומות בעיר אחרת. בלי זמני תפילה אם אינם כתובים; אפשר להציע לברר במקום.',
        [facts?.text || '', webText ? 'חיפוש באינטרנט:\n' + webText : ''].filter(Boolean).join('\n\n'), { maxTokens: 900, budgetMs: 11000, ctx: smallContext })
        .catch(() => facts?.items?.length ? nearbyReply(facts) : '');
      if (reply) return out({ reply });
    }
    log.warn?.('[PLACE] nothing on the map; falling back to the web');
    plan.intent = 'web'; plan.search = plan.search || plan.standalone || utterance;
  }

  if (plan.intent === 'web') {
    const q1 = plan.search || plan.standalone || utterance;
    const hours = /(?:פתוח|פתוחה|סגור|סגורה|שעות|עד מתי|מתי נפתח|מתי נסגר)/u.test(utterance + ' ' + plan.standalone);
    const route = ROUTE.test(utterance + ' ' + plan.standalone);
    // News: today's real headlines (with time and outlet) instead of news-site home pages.
    const news = deps.newsSearch && /(?:חדשות|מבזק|מבזקים|כותרות|מה קורה בארץ|מה קרה היום|מה חדש בעולם|מה חדש בארץ)/u.test(utterance + ' ' + plan.standalone);
    if (news) {
      const items = await deps.newsSearch(q1, { timeoutMs: 4000 }).catch(() => []);
      if (items.length >= 3) {
        const list = items.slice(0, 9).map((x, i) => 'כותרת ' + (i + 1) + ': ' + clip(x.title, 140) + (x.source ? ' (' + x.source + (x.date ? ', ' + x.date : '') + ')' : '') + (x.snippet ? '. ' + clip(x.snippet, 200) : '')).join('\n');
        log.info?.('[EXT3_BRAIN] news headlines', { count: items.length });
        const headlinesOnly = () => 'הנה הכותרות של עכשיו. ' + items.slice(0, 6).map((x, i) => (i ? 'ועוד ידיעה: ' : '') + clip(x.title, 150) + (x.source ? ', לפי ' + x.source : '') + '.').join(' ') + ' אם תרצה, אפרט על אחת מהן.';
        const reply = await ask('המתקשר רוצה לשמוע חדשות. לפניך הכותרות האמיתיות של עכשיו מחיפוש חדשות, עם מקור ושעה. ספרי לו את הידיעות החשובות והמעניינות ביותר, כל ידיעה במשפט או שניים עם הפרטים שבכותרת ובתקציר, כמו קריין חדשות חם וברור: קודם הדבר הגדול של היום, אחר כך עוד ידיעות מתחומים שונים. אל תמציאי פרטים שלא מופיעים, ואל תקריאי שמות אתרים ארוכים. בסוף שאלי אם לפרט על אחת הידיעות.', 'כותרות:\n' + list, { maxTokens: 1500, budgetMs: 12000, ctx: smallContext })
          // Every model busy: the real headlines are still worth hearing.
          .catch(() => headlinesOnly());
        return out({ reply });
      }
    }
    // Several things to look up in one sentence ("the weather and also the dollar"):
    // one search for each, and sources from each of them (13.11: the dollar was lost).
    const parts = (plan.searches || []).length >= 2 ? plan.searches : splitRequests(utterance);
    const multi = parts.length >= 2;
    const queries = multi ? parts.slice(0, 3) : [...new Set([q1, plan.standalone, hours ? q1.replace(/\s*(?:עכשיו|כרגע|היום)\s*/g, ' ') + ' שעות פתיחה' : '', route ? q1.replace(/\s*(?:עכשיו|כרגע|היום|הכי מהר|הכי מהיר|בבקשה)\s*/g, ' ') + ' קווי אוטובוס moovit' : ''].filter(Boolean))].slice(0, 3);
    const sets = await Promise.allSettled(queries.map(q => deps.webSearch(q, { timeoutMs: 4500 })));
    const seen = new Set(), results = [];
    const lists = sets.map(s => (s.status === 'fulfilled' ? s.value || [] : []).filter(r => r?.url).sort((a, b) => sourceRank(a.url) - sourceRank(b.url)));
    if (multi) {
      // Take turns between the parts, so every part keeps its best sources.
      for (let i = 0; i < 8; i++) for (const l of lists) { const r = l[i]; if (!r) continue; const key = String(r.url).replace(/[#?].*$/, ''); if (!seen.has(key)) { seen.add(key); results.push(r); } }
    } else {
      for (const l of lists) for (const r of l) {
        const key = String(r.url || '').replace(/[#?].*$/, '');
        if (seen.has(key)) continue;
        seen.add(key); results.push(r);
      }
      // Official sites first, then news, then the rest; social pages last.
      results.sort((a, b) => sourceRank(a.url) - sourceRank(b.url));
    }
    if (!results.length) {
      log.warn?.('[EXT3_BRAIN] web search found nothing; answering from knowledge with a caveat');
      const reply = await ask('חיפשת באינטרנט ולא נמצאו מקורות. ענה מהידע הכללי שלך רק על מה שאת בטוחה בו, ואמרי בפירוש שלא הצלחת לאמת עכשיו את הפרטים העדכניים.', '', { maxTokens: 1400 });
      return out({ reply });
    }
    let pages = [];
    if (deps.readPages) {
      const urls = results.filter(r => sourceRank(r.url) < 3).slice(0, multi ? 4 : 3).map(r => r.url);
      // Pages that answer within ~4 s are read; the rest stay as search snippets.
      pages = await Promise.race([deps.readPages(urls, { timeoutMs: 4000 }).catch(() => []), new Promise(r => setTimeout(() => r([]), 4200).unref?.())]);
    }
    const byUrl = new Map(pages.map(p => [String(p.url || '').replace(/[#?].*$/, ''), p]));
    let budget = 5200;
    const label = u => sourceRank(u) === 0 ? ' [אתר רשמי]' : sourceRank(u) === 1 ? ' [אתר חדשות]' : sourceRank(u) === 3 ? ' [רשת חברתית, פחות אמין]' : '';
    const sourceText = results.slice(0, 8).map((r, i) => {
      const page = byUrl.get(String(r.url).replace(/[#?].*$/, ''));
      const body = page?.content ? clip(page.content, Math.min(2200, Math.max(300, budget))) : clip(r.snippet, 420);
      budget -= body.length;
      return 'מקור ' + (i + 1) + label(r.url) + ': ' + clip(r.title, 120) + ' (' + hostOf(r.url).slice(0, 50) + ')\n' + body;
    }).join('\n\n').slice(0, 6500);
    log.info?.('[EXT3_BRAIN] web research', { queries, results: results.length, pagesRead: pages.length, official: results.filter(r => sourceRank(r.url) === 0).length, sourceChars: sourceText.length });
    const verify = 'בדיקת אמינות לפני שאת עונה: השווי בין המקורות. כשהם סותרים, העדיפי את האתר הרשמי, אחריו את המקור העדכני ביותר, ואמרי במפורש על איזה מקור את מתבססת ("לפי האתר הרשמי של כללית"). אל תצטטי שני מקורות סותרים בלי להכריע או להסביר. ' +
      (route ? 'זו שאלה על איך מגיעים ממקום למקום: אמרי רק קווים, חברות, תחנות וזמני נסיעה שכתובים במפורש במקורות, בדיוק כפי שהם, ובדקי שהם באמת בין שני המקומות שהוא אמר (לא עיר אחרת). אם המקורות לא נותנים מסלול ברור, אמרי בכנות שלא מצאת מסלול מאומת, תני את מה שכן ידוע בוודאות, והציעי לבדוק באפליקציית מוביט או במוקד המידע של התחבורה הציבורית בטלפון כוכבית 8787. אסור להמציא קו, החלפה, רכבת או זמן נסיעה. ' : '') +
      (hours ? 'זו שאלה על שעות פתיחה, ולכן כאן עני ממוקד וקצר יחסית (5 עד 8 משפטים) גם אם בדרך כלל את מרחיבה: האם פתוח עכשיו ועד מתי, השעות של היום ושל מחר, הכתובת והטלפון. בלי עצות שלא נשאלו. כתבי שעות תמיד מהמוקדמת למאוחרת, למשל משמונה בבוקר עד אחת בצהריים. אם אין לך התאמה ודאית למקום שביקש, אמרי זאת בשני משפטים ושאלי באיזו עיר הוא נמצא, בלי לפרט נתונים לא ודאיים. אם הסניף שמופיע במקורות נמצא בעיר או בשכונה אחרת ממה שהמתקשר אמר, אמרי איזה סניף מצאת ושאלי אם לזה התכוון. זו שאלה על שעות פתיחה: מצאי את שעות היום הנוכחי (' + now + '), חשבי בעצמך לפי השעה עכשיו האם המקום פתוח או סגור ברגע זה ועד מתי, ואמרי את זה בתחילת התשובה בבירור. אם אין שעות מפורשות ליום הזה, אמרי שאין לך שעות מאומתות להיום והציעי להתקשר למקום, עם מספר הטלפון אם מופיע. ' : '');
    const reply = await ask('המתקשר צריך מידע עדכני ומדויק. לפניך מקורות אמיתיים מהאינטרנט שנאספו ונקראו עכשיו לשאלה הזאת בלבד. אל תערבבי בתשובה מידע מתשובות קודמות שאינו קשור לשאלה הזאת. ' + verify +
      (multi ? 'הוא שאל כמה דברים: ' + parts.join('; ') + '. עני על כל אחד מהם בנפרד ולפי הסדר, ואם לאחד מהם אין תשובה במקורות, אמרי זאת. ' : '') +
      'כשמדובר בתחזית או בנתון יומי, השתמשי רק בנתון של היום (' + now + ') ואל תקריאי ימים שכבר עברו. ' + (hours ? 'ענה ממוקד ובבהירות, רק לפי המקורות:' : 'ענה בהרחבה ובפירוט רק לפי המקורות:') + ' עובדות, מספרים, שמות ותאריכים בדיוק כפי שכתובים בהם. כשהמקורות לא עונים על חלק מהשאלה, אמרי שלא מצאת את החלק הזה. אל תקריאי כתובות אתרים ואל תאמרי "מקור 1".', 'מקורות:\n' + sourceText, { maxTokens: hours ? 700 : 1800, budgetMs: 14000, ctx: smallContext })
      .catch(e => {
        log.warn?.('[EXT3_BRAIN] web answer not written; saying what was found', { status: e?.status || 0 });
        const seenHost = new Set();
        const bits = results.filter(r => /[֐-׿]/.test(r.snippet || '') && sourceRank(r.url) < 3).filter(r => { const h = hostOf(r.url); if (seenHost.has(h)) return false; seenHost.add(h); return clip(r.snippet, 30).length > 25; })
          .slice(0, 2).map(r => 'לפי ' + hostOf(r.url) + ': ' + clip(r.snippet, 230));
        return bits.length ? 'לפי מה שמצאתי עכשיו באינטרנט. ' + bits.join(' ') + ' זה בקצרה, כי מנועי הניסוח עמוסים ברגע זה. אם תשאל שוב בעוד דקה, אפרט יותר.' : '';
      });
    if (!reply) throw Object.assign(new Error('nothing to say'), { status: 503 });
    return out({ reply });
  }

  if (plan.intent === 'recall') {
    // "What did I ask you not to talk about?" is answered from the saved rules
    // themselves, with no model needed.
    const list = (prefs || []).map(x => String(x || '').trim()).filter(Boolean);
    if (list.length && /(?:ביקשתי|הוראה|הוראות|כללים|אמרתי לך ש?לא|ש?לא תדבר|ש?לא תדברי|מה אסור)/u.test(utterance))
      return out({ reply: 'ביקשת ממני: ' + list.slice(-5).map(x => x.replace(/[.!]+$/, '')).join('. וגם: ') + '. ואני מקפיד על זה.' });
    const reply = await ask('המתקשר שואל על שיחות קודמות או על עצמו. ענה רק מתוך הקשר השיחה, הסיכום וההוראות הקבועות שלו. פני אליו בלשון זכר ובגוף שני ("ביקשת ממני ש..."), במשפטים שלמים וברורים. כשהוא שואל פרט אחד, ענה עליו בפשטות. כשהוא שואל מה דיברנו, סכמי את הנושאים העיקריים לפי הסדר, עם הפרטים החשובים (למשל שם מדויק של סרטון שהומלץ). אם פרט לא מופיע, אמרי בכנות שאינך זוכרת אותו.', '', { maxTokens: 1000, budgetMs: 10000 });
    return out({ reply });
  }

  // A plain standing rule ("from now on don't talk about X"): a clear, fixed
  // acknowledgement (weak models garbled it), kept for the next calls too.
  if (plan.instruction && plan.intent === 'chat' && utterance.trim().split(/\s+/).length <= 14 && !/[?]|(?:מה|איך|למה|מתי|כמה|האם|תסבירי|תספרי)\s/u.test(utterance))
    return out({ reply: 'בסדר גמור, הבנתי ורשמתי לי את הבקשה שלך. אקפיד עליה מעכשיו, גם בשיחות הבאות. על מה תרצה שנדבר?' });

  // chat (talk, explanation, teaching, continuing an offer, a new standing instruction)
  const lessonWanted = looksLikeLessonRequest(utterance) || (plan.continueOffer && lessonRef);
  let reply = await ask('את עוזרת חכמה ונבונה בטלפון, עם ידע רחב בכל תחום. עני על מה שהמתקשר אמר עכשיו, בהמשך טבעי לשיחה.' +
    (plan.instruction ? ' המתקשר נתן עכשיו הוראה קבועה: "' + plan.instruction + '". אשרי בקצרה ובחום שתזכרי ותקיימי אותה מעכשיו, והמשיכי בהתאם.' : '') +
    (plan.about ? ' הוא שואל על המערכת עצמה ועל מה שהיא יודעת לעשות. עני בדיוק על מה ששאל, בכנות, רק מתוך העובדות על המערכת שלמטה, בלי לבצע שום פעולה ובלי להבטיח מה שלא כתוב שם. אם שאל "רק מ..." או "מאיזה אתרים", אמרי במפורש את התשובה. בסוף הציעי בקצרה איך לבקש את זה.' : ''),
    plan.about ? SYSTEM_FACTS : '', { maxTokens: 2000, budgetMs: 13000 });
  if (stuck) {
    // Keys must be clear: one short line and the options, nothing garbled around them.
    const keys = parseKeyOptions(reply) || parseKeyOptions(numberedToKeys(reply));
    if (keys) reply = 'בסדר, נבחר במקשים. ' + Object.entries(keys).map(([k, label]) => (/^ל/u.test(label) ? label : 'ל' + label) + ' הקש ' + k).join(', ') + '. אפשר גם לומר את המספר.';
  }
  let ref = null;
  if (lessonWanted) {
    const topic = lessonRef?.topic || lessonTopic(utterance) || lessonTopic(plan.standalone) || 'הנושא שביקש';
    ref = { type: 'lesson', topic, step: (lessonRef && lessonRef.topic === topic ? Number(lessonRef.step) || 1 : 0) + 1 };
  }
  return out({ reply, ref });
}

export { HE_NUMBER_WORDS };

const TIPS_ASKED = /(?:טיפ|טיפים|עצה|עצות|המלצות מעשיות|תן לי רעיונות|תני לי רעיונות)/u;

const GREETING = /^(?:שלום|היי|הי|הלו|אהלן|בוקר טוב|ערב טוב|לילה טוב|צהריים טובים|מה נשמע|מה שלומך|מה שלומך היום|מה קורה|מה המצב|מה העניינים|מה איתך|תודה|תודה רבה|יופי|מעולה|אחלה)(?:\s+(?:כפרה|אחי|חביבי|מותק|יקירתי|יקירי|גבר|נשמה|לך|רבה|לך רבה|בבקשה|עליך))*[\s?!.,]*$/u;
const FACTUAL = /(?:איך נקרא|איך קוראים ל|איך הם נקראים|מי שר|מי שרה|מי שרים|מי הזמר|מי הזמרת|מי המלחין|מי כתב את השיר|צמד|להקת|אלבום|אלבומים|שירים של|שיר של|דיסקוגרפיה|איך מגיעים|איך אני מגיע|איך להגיע|באיזה קו|איזה קו|קו אוטובוס|קווי אוטובוס|תחבורה ציבורית|מסלול נסיעה|כמה זמן נסיעה|מספר הטלפון|מה הטלפון|טלפון של|כתובת של|מה הכתובת|כמה עולה|מה המחיר|מחיר של|באיזו איכות|איזה פורמט|מי המנהל|מי הבעלים|מי ראש|מי שר ה|מי נשיא|מתי נולד|מתי נפטר|בן כמה|בת כמה)/u;
const ROUTE = /(?:איך מגיעים|איך אני מגיע|איך להגיע|להגיע ל|באיזה קו|איזה קו|קו אוטובוס|קווי אוטובוס|תחבורה ציבורית|אוטובוס ל|רכבת ל|מסלול נסיעה|הדרך הכי מהירה|הכי מהר ל|נסיעה ל)/u;

// A map or calendar service that hangs must not keep the caller waiting.
function within(ms, p) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('place tools too slow'), { status: 504 })), ms).unref?.())]); }

// The halachic time he asked about, said straight from the calculation (no
// model in between, so no time can be changed on the way). Null when he asked
// for something general ("the times of today") - the model then lists them.
const ZMAN_ASK = [
  [/קריאת שמע|ק״ש|ק"ש|זמן ק\s*ש|קש של/u, 'sofZmanShma', 'sofZmanShmaMGA', 'סוף זמן קריאת שמע'],
  [/סוף זמן תפילה|זמן תפילה|סוף זמן תפלה/u, 'sofZmanTfilla', 'sofZmanTfillaMGA', 'סוף זמן תפילה'],
  [/עלות השחר|עלות/u, 'alotHaShachar', '', 'עלות השחר'],
  [/משיכיר|זמן ציצית|זמן תפילין/u, 'misheyakir', '', 'הזמן המוקדם לציצית ותפילין, משיכיר,'],
  [/הנץ|נץ החמה|זריחה|הזריחה/u, 'sunrise', '', 'הנץ החמה'],
  [/מנחה גדולה/u, 'minchaGedola', '', 'מנחה גדולה'],
  [/מנחה קטנה/u, 'minchaKetana', '', 'מנחה קטנה'],
  [/פלג המנחה/u, 'plagHaMincha', '', 'פלג המנחה'],
  [/חצות הלילה|חצות לילה/u, 'chatzotNight', '', 'חצות הלילה'],
  [/חצות/u, 'chatzot', '', 'חצות היום'],
  [/צאת השבת|יציאת השבת|מוצאי שבת|מוצ״ש|הבדלה/u, 'tzeit85deg', 'tzeit72min', 'צאת השבת'],
  [/צאת הכוכבים|צאת הצום|סוף הצום/u, 'tzeit7083deg', 'tzeit85deg', 'צאת הכוכבים'],
  [/שקיעה|השקיעה|שקיעת/u, 'sunset', '', 'השקיעה']
];
export function zmanReply(facts, text) {
  const t = String(text || ''), times = facts?.times || {};
  if (/(?:זמני היום|כל הזמנים|זמני תפילה|זמנים הלכתיים|זמני הלכה)/u.test(t)) return null;
  if (/הדלקת נרות|כניסת השבת|זמן הדלקה/u.test(t)) {
    const line = facts.text.split('\n').find(l => l.startsWith('הדלקת נרות'));
    if (!line) return null;
    return 'הדלקת נרות שבת ' + facts.when + ' ב' + facts.loc.label + ' היא ב' + line.split(': ').pop() + ', ' + line.slice(line.indexOf('(') + 1, line.indexOf(')')) + '. השקיעה ב' + spokenTime(times.sunset) + '. בלוחות שונים יש לפעמים הבדל של דקה או שתיים, וכדאי לנהוג לפי הלוח של המקום.';
  }
  let asked = ZMAN_ASK.filter(([rx]) => rx.test(t));
  // "Shema on motzaei Shabbat": the Shabbat words only name the day.
  if (asked.some(a => /^sofZman/.test(a[1]))) asked = asked.filter(a => /^sofZman/.test(a[1]));
  if (asked.length !== 1) return null;
  const [, main, second, label] = asked[0];
  if (!times[main]) return null;
  const mga = /מגן אברהם|המג״א|מג"א|מגא(?![\u0590-\u05FF])/u.test(t);
  const where = facts.loc.label + (facts.loc.town && !sameTown(facts.loc.label, facts.loc.town) ? ' שב' + facts.loc.town : '');
  const placeNote = facts.loc.assumed ? ' לפי ירושלים, כי לא אמרת מקום' : ' ' + prep('ב', where) + (facts.loc.approx ? ' (לפי מרכז היישוב)' : '');
  let reply;
  if (main === 'sofZmanShma' || main === 'sofZmanTfilla') {
    const [a, b] = mga ? [second, main] : [main, second];
    const name = k => k.endsWith('MGA') ? 'לפי המגן אברהם' : 'לפי הגר״א';
    reply = label + ' ' + name(a) + placeNote + ' ' + facts.when + ' הוא ב' + spokenTime(times[a]) + '.' + (times[b] ? ' ' + name(b) + ' הוא מוקדם יותר, ב' + spokenTime(times[b]) + '.' : '') + ' הנץ החמה שם ב' + spokenTime(times.sunrise) + '.';
  } else if (main === 'tzeit85deg') {
    reply = 'צאת השבת' + placeNote + ' ' + facts.when + ' היא ב' + spokenTime(times.tzeit85deg) + ', לפי שמונה וחצי מעלות.' + (times.tzeit72min ? ' לפי רבנו תם, ב' + spokenTime(times.tzeit72min) + '.' : '');
  } else {
    reply = label + placeNote + ' ' + facts.when + ' ב' + spokenTime(times[main]) + '.' + (second && times[second] ? ' ולפי שיטה מחמירה יותר, ב' + spokenTime(times[second]) + '.' : '');
  }
  return reply + ' זה חישוב לפי המיקום המדויק; בלוחות שונים יש לפעמים הבדל של דקה או שתיים, וכדאי לנהוג לפי הלוח והרב של המקום.';
}
// "ל" + "החוף" = "לחוף"; "ב" + "הרב קוק 3" = "ברחוב הרב קוק 3".
const prep = (p, w) => p + String(w || '').replace(/^ה(?=[\u0590-\u05FF]{2})/u, '');
const street = a => /^(?:רחוב|רח |שדרות|שד |דרך|סמטת|כיכר|מעלה|שביל)/u.test(a) ? a : 'רחוב ' + a;
function nearbyReply(facts) {
  const [a, ...rest] = facts.items;
  const one = x => (x.name || facts.kind + ' בלי שם במפה') + ', במרחק ' + spokenDistance(x.km) + (x.address ? ', ב' + street(x.address) : '');
  return 'לפי המפה, ' + facts.kind + ' הקרוב ביותר ' + prep('ל', facts.loc.label) + ' הוא ' + one(a) + '.' + (rest.length ? ' עוד קרובים: ' + rest.slice(0, 2).map(one).join('; ') + '.' : '') + ' המרחקים בקו אווירי.';
}

/**
 * Numbered choices in a reply ("ללימוד קוד הקש 1, ללימוד פריסה הקש 2"):
 * { '1': 'ללימוד קוד', '2': 'ללימוד פריסה' }, or null when there are none.
 * The call then really waits for a key, and the key becomes the choice.
 */
export function parseKeyOptions(text) {
  const t = String(text || '').replace(/\s*¶\s*/g, '. ');
  const out = {};
  const clean = x => String(x || '').replace(/^[\s,.:;\-–]+|[\s,.:;\-–]+$/g, '').replace(/^(?:ו|או\s+)/u, '').trim().slice(0, 90);
  // "הקש 1 ל<label>"
  for (const m of t.matchAll(/(?:הקש|הקישו|לחץ|לחצו)\s*([1-9])(?!\d)\s*(?:-|–)?\s*(ל[^,.;:?!]{2,90})/gu)) if (!/(?:הקש|לחץ)/u.test(m[2])) out[m[1]] ||= clean(m[2]);
  // "<label> הקש 1" / "<label> - לחץ 1"
  for (const m of t.matchAll(/([^,.;:?!]{2,90}?)\s*(?:,|-|–)?\s*(?:הקש|הקישו|הקישי|לחץ|לחצו|לחצי|הקשה על|מקש)\s*(?:על\s*)?(?:מקש\s*)?([1-9])(?!\d)/gu)) {
    const label = clean(m[1]);
    if (label && !/(?:הקש|לחץ)/u.test(label) && !/^(?:אפשר|ניתן|כדי|אם)$/.test(label)) out[m[2]] ||= label;
  }
  // "אפשרות 1: <label>" / numbered list "1. <label>"
  const listed = {};
  for (const m of t.matchAll(/(?:^|[.?!:]\s+|אפשרות\s+)([1-6])\s*[.):,]\s*([^.?!]{3,90})/gu)) listed[m[1]] ||= clean(m[2]);
  if (Object.keys(listed).length >= 2 && listed['1'] && listed['2']) for (const [k, v] of Object.entries(listed)) out[k] ||= v;
  const keys = Object.keys(out);
  if (!keys.length) return null;
  // A lone "press 1" with nothing else is still a real choice.
  return out;
}
