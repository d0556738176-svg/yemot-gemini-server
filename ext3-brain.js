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

export const INTENTS = ['library', 'chat', 'web', 'video_find', 'video_about', 'video_play', 'media_status', 'cancel', 'read_page', 'recall'];

export function plannerPrompt({ context, utterance, now, video, media = '', prefs = [] }) {
  return [
    'אתה המתכנן של עוזרת טלפונית חכמה. קרא את ההקשר ואת מה שהמתקשר אמר עכשיו, והחלט מה התור הזה צריך. אל תענה למתקשר.',
    'התמלול של הטלפון לפעמים משבש מילים (למשל "יויוטב" במקום "יוטיוב", או שם של חברה שלא נאמר). פרש לפי ההקשר והכוונה, לא לפי מילה בודדת.',
    'אפשרויות intent:',
    'chat = שיחה, הסבר, לימוד, עצה, ידע כללי, המשך של שיעור או של הצעה קודמת ("כן", "תמשיכי", "אחת", "בטח").',
    'web = צריך מידע עדכני או מדויק מהאינטרנט: חדשות, מחירים, מי מכהן היום, פרטי עסק, אירועים אחרונים, נתונים שמשתנים, או כשהמתקשר מבקש לחפש.',
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
    '{"intent":"...","standalone":"השאלה כמשפט עצמאי וברור בעברית עם כל הפרטים מההקשר","search":"שאילתת חיפוש קצרה לאינטרנט אם intent=web או read_page","yt_he":"שאילתת חיפוש ביוטיוב בעברית: לסרטון/שיר שהמתקשר מתכוון אליו לפי ההקשר (למשל שם הזמר והשיר שדובר עליהם), לא המשפט שאמר","yt_en":"אותה שאילתה באנגלית אם מתאים","min_minutes":0,"max_minutes":0,"recent_days":0,"order":"relevance או date או views","play":"audio או video","continue_offer":false,"instruction":""}',
    'recent_days: כשביקש משהו חדש (השבוע=7, לאחרונה/חדש=30, היום=2). order: date כשביקש "הכי חדש", views כשביקש "הכי הרבה צפיות". שיר בודד = max_minutes 8, ואם אמר שאינו רוצה סט/רשימה/מיקס אל תחפשי סט.',
    'play = "video" רק כשהמתקשר ביקש במפורש להוריד את הווידאו/הסרטון עצמו. continue_offer = true כשהמתקשר רק מסכים להמשיך את מה שהוצע לו בתשובה הקודמת.',
    'min_minutes/max_minutes רק אם ביקש אורך (למשל "כשעה" = min 40).',
    '',
    'הזמן עכשיו בישראל: ' + now,
    video ? 'הסרטון האחרון שהוזכר: ' + refLine(video) : 'לא הוזכר עדיין סרטון.',
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
    ytHe: str(j.yt_he),
    ytEn: str(j.yt_en),
    minMinutes: Math.max(0, Number(j.min_minutes) || 0),
    maxMinutes: Math.max(0, Number(j.max_minutes) || 0),
    play: j.play === 'video' ? 'video' : 'audio',
    continueOffer: j.continue_offer === true,
    recentDays: Math.max(0, Math.min(365, Number(j.recent_days) || 0)),
    order: ['date', 'views'].includes(j.order) ? j.order : 'relevance',
    instruction: str(j.instruction)
  };
}

const YT_WORD = /(?:יוטיוב|יויוטב|יוטוב|יו טיוב|youtube)/iu;
const VIDEO_WORD = /(?:סרטון|סרטונים|סרט|הרצאה|וידאו|וידיאו|דוקו|תיעודי)/u;
const SONG_WORD = /(?:שיר|שירים|קליפ|סינגל|להיט|להיטים|הופעה|סט |מחרוזת|פרק|פרקים)/u;

/** Used when every planner model is down: plain, conservative rules. */
export function heuristicPlan(utterance, { video = null } = {}) {
  const u = String(utterance || '').trim();
  const base = { standalone: u, search: u, ytHe: u.replace(YT_WORD, ' ').replace(/\s+/g, ' ').trim(), ytEn: '', minMinutes: 0, maxMinutes: 0, recentDays: /(?:השבוע|לאחרונה|חדש|חדשים|הכי טרי)/u.test(u) ? 30 : 0, order: 'relevance', instruction: '', play: /(?:להוריד|תוריד|הורד).{0,20}(?:וידאו|וידיאו|סרטון עצמו)|כן לוידאו/u.test(u) ? 'video' : 'audio', continueOffer: false };
  // A key choice that names something to hear ("לשמיעת השיר X") is a play request.
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
  // The video named in the request, not the whole sentence, is what gets searched.
  if (/(?:תשמיע|תשמיעי|להשמיע|תפעיל|תפעילי|לשמוע את|תוריד|תורידי|להוריד)/u.test(u) && !/^(?:לא|אל)(?=$|[\s,.!?])/u.test(u)) return { ...base, intent: 'video_play', ytHe: video && /(?:אותו|אותה|זה|הזה|הזאת|שלו|שלה)/u.test(u) ? '' : u.replace(/(?:הלו|כן|בבקשה|אני רוצה|תשמיעי|תשמיע|להשמיע|לשמוע|לי|את|תפעילי|תפעיל|תורידי|תוריד|להוריד|השיר|הסרטון|ה?ו?וידי?או|קובץ שמע|ביוטיוב|יוטיוב)/gu, ' ').replace(/\s+/g, ' ').trim() };
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
export async function findVideos(queries, { minMinutes = 0, maxMinutes = 0, recentDays = 0, order = 'relevance', exclude = [], env, fetchImpl, proxy, regionCode = 'IL' } = {}) {
  const qs = [...new Set((queries || []).map(q => String(q || '').trim()).filter(q => q.length >= 2))].slice(0, 3);
  const duration = minMinutes >= 20 ? 'long' : (maxMinutes && maxMinutes <= 4) ? 'short' : (minMinutes >= 4 && (!maxMinutes || maxMinutes <= 20)) ? 'medium' : 'any';
  const lists = await Promise.allSettled(qs.map(q => youtubeGet('search', {
    part: 'snippet', q, type: 'video', maxResults: 15, safeSearch: 'strict', regionCode, relevanceLanguage: /[a-z]/i.test(q) && !/[֐-׿]/.test(q) ? 'en' : 'he', videoDuration: duration,
    order: order === 'date' ? 'date' : order === 'views' ? 'viewCount' : 'relevance',
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
  if (order === 'date') videos.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  else if (order === 'views') videos.sort((a, b) => b.viewCount - a.viewCount);
  else {
    // The original song first: karaoke, covers, lyric and remix uploads only when he asked for one.
    const ALT = /(?:קריוקי|karaoke|cover|קאבר|lyrics|lyric video|מילים|instrumental|פלייבק|playback|remix|רמיקס|\b8d\b|slowed|sped up|נייטקור|nightcore|tiktok|טיקטוק)/iu;
    const askedAlt = ALT.test((queries || []).join(' '));
    const alt = v => (!askedAlt && ALT.test(v.title)) ? 8 : 0;
    // When he named a song, the titles that carry all of his words come first
    // ("אושר כהן דאון" -> the versions of "דאון"), and among those the original.
    const STOP = new Set(['שיר', 'השיר', 'של', 'את', 'לי', 'סרטון', 'הסרטון', 'בבקשה', 'קליפ', 'הקליפ']);
    const qWords = String((queries || [])[0] || '').replace(/[^\u0590-\u05FFa-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
    const fit = v => { if (!qWords.length) return 0; const t = String(v.title || '').toLowerCase(); return qWords.filter(w => t.includes(w.toLowerCase())).length / qWords.length; };
    const best = Math.max(0, ...videos.map(fit));
    if (qWords.length && qWords.length <= 6 && best >= 0.99) videos = videos.filter(v => fit(v) >= 0.99);
    if (!askedAlt && videos.some(v => !ALT.test(v.title))) videos = videos.filter(v => !ALT.test(v.title));
    videos.sort((a, b) => (rank.get(a.videoId) + alt(a) - rank.get(b.videoId) - alt(b)) - 4 * (Math.log10(b.viewCount + 10) - Math.log10(a.viewCount + 10)));
  }
  return videos.slice(0, 10);
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
  'ענה בהרחבה ובפירוט מלא, כמו מומחית שמסבירה לחבר בכיף ובזרימה: קודם תשובה ישירה, אחר כך הסבר עשיר ומסודר עם הפרטים החשובים, דוגמאות מהחיים ותובנות מעניינות, ובסוף משפט סיכום או שאלת המשך אחת שמקדמת את השיחה. תשובה רגילה: לפחות 10 משפטים מלאים. כשמבקשים "בהרחבה" או "בפירוט": 15 עד 25 משפטים. רק כשהמתקשר מבקש לקצר, או כשהתשובה באמת קצרה מטבעה (שעה, שם, מספר, כן או לא), ענה קצר.',
  'עני על כל חלקי השאלה. כשאת לא יודעת פרט, אמרי זאת במפורש ("את שמך עוד לא אמרת לי") והמשיכי לשאר השאלה.',
  'אל תאמרי "המקורות שסופקו" או "לפי ההקשר": דברי בטבעיות, למשל "לפי מה שמצאתי עכשיו".',
  'כשאת מציעה למתקשר לבחור בין כמה אפשרויות, קודם הסבירי במשפט או שניים מה כל אפשרות, ואז אמרי אותן בפורמט קבוע עם השם האמיתי של כל אפשרות לפני המקש, למשל: "למשתנים ונתונים הקש 1, לתנאים והחלטות הקש 2, ללולאות הקש 3", עד 6 אפשרויות, ואמרי שאפשר גם לומר את המספר. אסור לכתוב "הנושא הראשון" במקום שם אמיתי. המקשים האלה באמת עובדים בשיחה. כשהמתקשר בחר אפשרות, התחילי מיד את מה שבחר, בפירוט, בלי לחזור על הרשימה.',
  'אל תמציא שמות, מספרים, מחירים, תאריכים, סרטונים, ערוצים או ציטוטים. כשאינך בטוחה בפרט, אמור זאת בפשטות.',
  // Owner, 12.11: no stock phrases; talk like a real, warm person.
  'פתחי ישר בתוכן עצמו. אסור לפתוח במילות נימוס קבועות כמו "שמחתי לשמוע", "שמחה לעזור", "שאלה מצוינת", "שאלה טובה", "בשמחה", "בהחלט", "כמובן", "תודה ששאלת", ואסור לחזור מתשובה לתשובה על אותם ביטויים, אותה פתיחה או אותה שאלת סיום. דברי כמו אדם אמיתי: חם, נעים, סקרן ומגוון, עם הומור עדין כשמתאים, כמו חבר חכם שכיף לדבר איתו.',
  'את לא משמיעה ולא מורידה בעצמך דרך מה שאת כותבת: אל תאמרי "משמיעה עכשיו" ואל תבטיחי להשמיע. כשהמתקשר רוצה לשמוע משהו, אמרי לו לומר "תשמיעי לי את" ואת שם השיר או הסרטון.'
].join(' ');
// Stock openings that slip through anyway are cut off the answer.
const STOCK_OPENING = /^(?:\s*(?:(?:אני\s+)?(?:שמחתי|שמחה|שמח)\s+(?:מאוד\s+)?(?:לשמוע|לעזור|שפנית|ששאלת|שאתה|על)[^.!?,]*[.!?,]|(?:איזו\s+|זו\s+)?שאלה\s+(?:מצוינת|טובה|מעולה|נהדרת|יפה|מעניינת)[^.!?,]*[.!?,]|בשמחה[.!?,]|בהחלט[.!?,]|כמובן[.!?,]|תודה (?:ששאלת|על השאלה)[^.!?,]*[.!?,])\s*)+/u;
export function cutStockOpening(text) { const t = String(text || ''); const cut = t.replace(STOCK_OPENING, ''); return cut.length > 20 ? cut : t; }

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
    : 'כלל אורך שגובר על כל הוראה אחרת למעלה: ענה בקצרה, 2 עד 4 משפטים ברורים וישר לעניין, עם הפרט החשוב ביותר (מספר, שעה, שם) בהתחלה. אל תרחיב אלא אם המתקשר מבקש "בהרחבה" או "תפרט". כשאתה מציע אפשרויות במקשים, אמור אותן במלואן גם בתשובה קצרה.';
}

export function teachingRule(lesson) {
  return 'כשהמתקשר רוצה ללמוד נושא (למשל תכנות), את המורה שלו כאן בטלפון: מלמדת שיעור אמיתי בשלבים, מסבירה מושג אחד או שניים בכל פעם בדוגמאות מהחיים, מתארת קוד במילים (למשל "כותבים פְּרִינְט, פותחים סוגריים...") ולא מפנה לאתרים, לקורסים או לסרטונים. בסוף כל שלב שאלי אם להמשיך לשלב הבא. ' +
    (lesson ? 'כרגע יש שיעור פעיל: ' + refLine(lesson) + '. אם המתקשר אומר כן או תמשיכי, המשיכי ישר לשלב הבא שלו בלי לחזור על ההקדמה. ' : '');
}

// Standing instructions the caller gave ("don't talk about X", "always short").
export function prefsBlock(prefs = []) {
  const list = (prefs || []).map(x => String(x || '').trim()).filter(Boolean).slice(-15);
  return list.length ? 'הוראות קבועות שהמתקשר נתן לך. חובה לקיים אותן תמיד, בכל תשובה, גם בשיחות הבאות:\n- ' + list.join('\n- ') : '';
}

export function answerPrompt({ context, utterance, plan, now, instruction, extra = '', lesson = null, prefs = [], media = '', stuck = false, voice = 'female', brief = false }) {
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
    '',
    voiceRule(voice),
    lengthRule(brief, utterance),
    'החזר אובייקט JSON תקין בלבד עם שדה "answer".'
  ].filter(x => x !== '').join('\n');
}

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
  const video = activeVideo(current, prior);
  const lessonRef = activeLesson(current);
  const article = activeArticle(current);
  const context = buildContext({ summary, prior, current, maxChars: 5200 });
  const smallContext = buildContext({ summary, prior, current, maxChars: 2600 });
  const stuck = isStuck(utterance, current);
  let plan = null;
  const t0 = Date.now();
  const rules = heuristicPlan(utterance, { video });
  const continuing = /^(?:כן|תמשיכי|תמשיך|המשיכי|המשך|הלאה|נמשיך|עוד)(?=$|[\s,.!?])/u.test(utterance.trim());
  const sure = !stuck && (rules.continueOffer || ['media_status', 'cancel', 'library'].includes(rules.intent) || (rules.intent === 'video_play' && /^בחרתי באפשרות/u.test(utterance)) || (video && ['video_play', 'video_about'].includes(rules.intent) && !rules.ytHe));
  if (article && continuing) plan = { ...rules, intent: 'read_page', continueOffer: true };
  else if (sure) plan = rules;
  else try {
    plan = parsePlan(await deps.llm(plannerPrompt({ context: smallContext, utterance, now, video, media, prefs }), { budgetMs: Number(deps.plannerBudgetMs || 3200), maxTokens: 450, planner: true }));
  } catch (e) { log.warn?.('[EXT3_BRAIN] planner unavailable; using rules', { status: e?.status || 0 }); }
  if (!plan) plan = rules;
  // A song or video to find stays a YouTube search even when the planner
  // called it a web question (12.11: "a new song by Shwekey" got a web answer).
  if (rules.intent === 'video_find' && ['web', 'chat'].includes(plan.intent)) plan = { ...plan, intent: 'video_find', ytHe: plan.ytHe || rules.ytHe, recentDays: plan.recentDays || rules.recentDays };
  // A standing instruction said in plain words is kept even when the planner missed it.
  // Only when he really said a standing rule (the planner sometimes fills the
  // field with a description of the request).
  const ruleWords = /(?:אל תדברי|אל תדבר|תפסיקי לדבר|תפסיק לדבר|אל תספרי|אל תזכירי|אני לא רוצה שתדברי|אני לא רוצה שתזכירי|מעכשיו|מהיום והלאה|מהיום ת|תמיד ת|אף פעם אל|אף פעם לא|תזכרי ש|תזכור ש|בפעם הבאה ש|תדברי איתי ב|תדברי אליי ב|תפני אליי)/u.test(utterance);
  if (!ruleWords) plan.instruction = '';
  else {
    if (!plan.instruction) plan.instruction = utterance.trim().slice(0, 200);
    // "From now on don't talk about X" is a rule, not a cancel or a search.
    if (['cancel', 'media_status'].includes(plan.intent) || (plan.intent === 'web' && !/(?:תחפשי|תחפש|באינטרנט|ברשת)/u.test(utterance))) plan.intent = 'chat';
  }
  if ((plan.intent === 'video_find' || plan.intent === 'video_play') && !plan.minMinutes && /(?:ארוך|ארוכה|ארוכים|מלא|שעה)/u.test(utterance)) plan.minMinutes = /שעה/u.test(utterance) ? 40 : 20;
  if ((plan.intent === 'video_find' || plan.intent === 'video_play') && !plan.maxMinutes && /(?:שיר בודד|סינגל|שיר אחד|לא סט|בלי סט|לא רוצה סט)/u.test(utterance)) plan.maxMinutes = 8;
  if (!video && plan.intent === 'video_about') plan.intent = 'recall';
  // A video download only when the caller said so.
  plan.play = /(?:להוריד|תוריד|תורידי|הורד|הורדה|הורדת).{0,25}(?:וידאו|וידיאו|ווידאו|סרטון עצמו|הסרטון)|(?:וידאו|וידיאו|ווידאו).{0,15}(?:להוריד|תוריד|תורידי)|כן לוידאו/u.test(utterance) ? 'video' : 'audio';
  log.info?.('[EXT3_BRAIN] plan', { intent: plan.intent, standalone: plan.standalone.slice(0, 140), search: plan.search.slice(0, 100), yt: plan.ytHe.slice(0, 80), stuck, instruction: !!plan.instruction, ms: Date.now() - t0 });
  const out = extra => ({ intent: plan.intent, ...(plan.instruction ? { instruction: plan.instruction } : {}), ...extra });

  // Sources leave less room for the conversation: the whole request must stay
  // small enough for the free fast models (they refuse big ones with 413).
  const ask = async (instruction, extra = '', { maxTokens = 1800, budgetMs = 13000, lesson = lessonRef, ctx = context } = {}) => {
    let raw;
    const common = { utterance, plan, now, instruction, lesson, prefs, media, stuck, voice, brief };
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
  if (plan.intent === 'cancel') return out({ cancel: true, reply: '' });

  if (plan.intent === 'library') {
    const lib = deps.library ? await deps.library().catch(() => []) : [];
    if (!lib.length) return out({ reply: 'עוד לא מצאתי שירים שהורדו ושמורים במערכת. אפשר לבקש ממני שיר או סרטון, ואמצא ואוריד אותו בשבילך.' });
    const recent = [...lib].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
    return out({ reply: 'יש אצלך במערכת ' + lib.length + ' שירים וקבצים שכבר הורדו, והם מתנגנים מיד בלי הורדה נוספת. האחרונים שהורדו: ' +
      recent.map((x, i) => 'לשמיעת ' + clip(x.title, 70) + ' הקש ' + (i + 1)).join(', ') + '. אפשר גם לבקש כל שיר אחר בשמו.' });
  }

  if (plan.intent === 'video_play') {
    // Already downloaded? Then it plays now, with no new download (unless he
    // asked to download it again).
    const lib = deps.library && !AGAIN.test(utterance) ? await deps.library().catch(() => []) : [];
    const fromLib = item => out({ ref: { type: 'video', videoId: item.videoId, title: item.title }, play: { paths: [item.path], durationSec: 0, title: item.title },
      reply: clip(item.title, 140) + ' כבר שמור אצלך במערכת, אז לא צריך להוריד אותו שוב. משמיעה אותו עכשיו.' });
    if (lib.length) {
      const pointsAtItEarly = /(?:אותו|אותה|הזה|הזאת|את זה|שלו|שלה|שהמלצת|שאמרת|שדיברנו|שמצאת)/u.test(utterance);
      const ownName = !pointsAtItEarly && rules.intent === 'video_play' && rules.ytHe && rules.ytHe.length >= 3 ? rules.ytHe : (plan.ytHe || '');
      const hit = (video && (pointsAtItEarly || !ownName) && lib.find(x => x.videoId === video.videoId)) || (ownName && libraryMatch(lib, ownName));
      if (hit) return fromLib(hit);
    }
    // Which video: the one on record when he points at it, otherwise the one he
    // names (searched by name, never by the whole sentence). Nothing is
    // downloaded here: he hears the full title first and chooses with a key.
    let v = null;
    const pointsAtIt = /(?:אותו|אותה|הזה|הזאת|את זה|שלו|שלה|שהמלצת|שאמרת|שדיברנו|שמצאת)/u.test(utterance);
    // His own words name the target first (the planner sometimes fills in the
    // video already on record instead of the new name he said).
    const ownName = !pointsAtIt && rules.intent === 'video_play' && rules.ytHe && rules.ytHe.length >= 3 ? rules.ytHe : '';
    const named = ownName || (plan.ytHe && plan.ytHe.length >= 3 ? plan.ytHe : '');
    const overlap = (a, b) => { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return A.size ? n / A.size : 0; };
    // The old video only when every word he said is in its title ("אושר כהן דאון" is not "אושר כהן - אין אותי").
    if (video && (!named || pointsAtIt || overlap(named, video.title) >= 0.85)) v = video;
    else if (named) {
      const found = await (deps.findVideos || findVideos)([named, plan.ytEn], { minMinutes: plan.minMinutes, maxMinutes: plan.maxMinutes, env: deps.env, fetchImpl: deps.fetchImpl, proxy: deps.youtubeProxy }).catch(() => []);
      if (found[0]) v = videoRef(found[0]);
    }
    const inLib = v && lib.find(x => x.videoId === v.videoId);
    if (inLib) return fromLib(inLib);
    if (!v) return out({ reply: 'עוד לא בחרנו סרטון מסוים. ספר לי את שם השיר או הסרטון שאתה רוצה, ואמצא לך אותו ביוטיוב.' });
    return out({
      ref: v,
      confirm: { videoId: v.videoId, title: v.title, channelTitle: v.channelTitle, durationSec: v.durationSec, mode: plan.play },
      reply: 'לפני שאני מורידה, רק לוודא שזה הסרטון הנכון: ' + v.title + (v.channelTitle ? ', בערוץ ' + v.channelTitle : '') + (v.durationSec ? ', אורכו ' + spokenDuration(v.durationSec) : '') + '. ' +
        'להורדת קובץ שמע הקש 1, להורדת וידאו הקש 2, לביטול והמשך השיחה הקש 3. אפשר גם לומר אחת, שתיים או שלוש.'
    });
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
    if (!found.length) return out({ reply: 'חיפשתי ביוטיוב ולא מצאתי סרטון שמתאים בדיוק למה שביקשת. אפשר לתאר לי במילים אחרות את הנושא, או לומר אם חשוב לך שיהיה בעברית או באורך מסוים, ואחפש שוב.' });
    const instruction = 'המתקשר ביקש המלצה על סרטון. לפניך רשימת סרטונים אמיתיים שנמצאו עכשיו ביוטיוב, עם הכותרת המדויקת, הערוץ, האורך בדקות, מספר הצפיות, תאריך הפרסום והתיאור. ' +
      'בחרי את הסרטון המתאים ביותר לבקשה: קודם שיתאים בדיוק לנושא, לסוג (שיר בודד, סט, הרצאה), לשפה, לאורך ולמידת החדשות שביקש, ובין המתאימים עדיף סרטון איכותי ופופולרי. אסור להמליץ על סרטון שאינו ברשימה, ואסור לשנות את הכותרת, הערוץ, האורך או התאריך. ' +
      'בתשובה אמרי את הכותרת המדויקת כפי שהיא (ואם היא בשפה זרה גם תרגום לעברית), את שם הערוץ, את האורך, מתי פורסם ואת מספר הצפיות, ותארי בעברית במילים שלך על מה הסרטון רק לפי התיאור שלו, בלי להמציא. ' +
      'סיימי בכך שאפשר לומר "תשמיעי לי אותו" כדי לשמוע או להוריד אותו. ' +
      'החזר JSON בלבד בצורה {"pick":מספר i של הסרטון הנבחר,"answer":"התשובה למתקשר"}.';
    let pick = 0, reply = '';
    try {
      const raw = await deps.llm(answerPrompt({ context: smallContext, utterance, plan, now, instruction, prefs, voice, brief, extra: 'סרטונים שנמצאו:\n' + candidatesText(found.slice(0, 8)) }), { budgetMs: 12000, maxTokens: 1400 });
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
    return out({ ref: videoRef(v), reply });
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

  if (plan.intent === 'web') {
    const q1 = plan.search || plan.standalone || utterance;
    const hours = /(?:פתוח|פתוחה|סגור|סגורה|שעות|עד מתי|מתי נפתח|מתי נסגר)/u.test(utterance + ' ' + plan.standalone);
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
    const queries = [...new Set([q1, plan.standalone, hours ? q1.replace(/\s*(?:עכשיו|כרגע|היום)\s*/g, ' ') + ' שעות פתיחה' : ''].filter(Boolean))].slice(0, 3);
    const sets = await Promise.allSettled(queries.map(q => deps.webSearch(q, { timeoutMs: 4500 })));
    const seen = new Set(), results = [];
    for (const s of sets) for (const r of (s.status === 'fulfilled' ? s.value || [] : [])) {
      const key = String(r.url || '').replace(/[#?].*$/, '');
      if (!r.url || seen.has(key)) continue;
      seen.add(key); results.push(r);
    }
    // Official sites first, then news, then the rest; social pages last.
    results.sort((a, b) => sourceRank(a.url) - sourceRank(b.url));
    if (!results.length) {
      log.warn?.('[EXT3_BRAIN] web search found nothing; answering from knowledge with a caveat');
      const reply = await ask('חיפשת באינטרנט ולא נמצאו מקורות. ענה מהידע הכללי שלך רק על מה שאת בטוחה בו, ואמרי בפירוש שלא הצלחת לאמת עכשיו את הפרטים העדכניים.', '', { maxTokens: 1400 });
      return out({ reply });
    }
    let pages = [];
    if (deps.readPages) {
      const urls = results.filter(r => sourceRank(r.url) < 3).slice(0, 3).map(r => r.url);
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
      (hours ? 'זו שאלה על שעות פתיחה, ולכן כאן עני ממוקד וקצר יחסית (5 עד 8 משפטים) גם אם בדרך כלל את מרחיבה: האם פתוח עכשיו ועד מתי, השעות של היום ושל מחר, הכתובת והטלפון. בלי עצות שלא נשאלו. כתבי שעות תמיד מהמוקדמת למאוחרת, למשל משמונה בבוקר עד אחת בצהריים. אם אין לך התאמה ודאית למקום שביקש, אמרי זאת בשני משפטים ושאלי באיזו עיר הוא נמצא, בלי לפרט נתונים לא ודאיים. אם הסניף שמופיע במקורות נמצא בעיר או בשכונה אחרת ממה שהמתקשר אמר, אמרי איזה סניף מצאת ושאלי אם לזה התכוון. זו שאלה על שעות פתיחה: מצאי את שעות היום הנוכחי (' + now + '), חשבי בעצמך לפי השעה עכשיו האם המקום פתוח או סגור ברגע זה ועד מתי, ואמרי את זה בתחילת התשובה בבירור. אם אין שעות מפורשות ליום הזה, אמרי שאין לך שעות מאומתות להיום והציעי להתקשר למקום, עם מספר הטלפון אם מופיע. ' : '');
    const reply = await ask('המתקשר צריך מידע עדכני ומדויק. לפניך מקורות אמיתיים מהאינטרנט שנאספו ונקראו עכשיו לשאלה הזאת בלבד. אל תערבבי בתשובה מידע מתשובות קודמות שאינו קשור לשאלה הזאת. ' + verify + (hours ? 'ענה ממוקד ובבהירות, רק לפי המקורות:' : 'ענה בהרחבה ובפירוט רק לפי המקורות:') + ' עובדות, מספרים, שמות ותאריכים בדיוק כפי שכתובים בהם. כשהמקורות לא עונים על חלק מהשאלה, אמרי שלא מצאת את החלק הזה. אל תקריאי כתובות אתרים ואל תאמרי "מקור 1".', 'מקורות:\n' + sourceText, { maxTokens: hours ? 700 : 1800, budgetMs: 14000, ctx: smallContext })
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
    (plan.instruction ? ' המתקשר נתן עכשיו הוראה קבועה: "' + plan.instruction + '". אשרי בקצרה ובחום שתזכרי ותקיימי אותה מעכשיו, והמשיכי בהתאם.' : ''), '', { maxTokens: 2000, budgetMs: 13000 });
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
