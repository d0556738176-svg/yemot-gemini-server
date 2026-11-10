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

export const INTENTS = ['chat', 'web', 'video_find', 'video_about', 'video_play', 'recall'];

export function plannerPrompt({ context, utterance, now, video }) {
  return [
    'אתה המתכנן של עוזרת טלפונית חכמה. קרא את ההקשר ואת מה שהמתקשר אמר עכשיו, והחלט מה התור הזה צריך. אל תענה למתקשר.',
    'התמלול של הטלפון לפעמים משבש מילים (למשל "יויוטב" במקום "יוטיוב", או שם של חברה שלא נאמר). פרש לפי ההקשר והכוונה, לא לפי מילה בודדת.',
    'אפשרויות intent:',
    'chat = שיחה, הסבר, לימוד, עצה, ידע כללי, המשך של שיעור או של הצעה קודמת ("כן", "תמשיכי", "אחת", "בטח").',
    'web = צריך מידע עדכני או מדויק מהאינטרנט: חדשות, מחירים, מי מכהן היום, פרטי עסק, אירועים אחרונים, נתונים שמשתנים, או כשהמתקשר מבקש לחפש.',
    'video_find = המתקשר רוצה שתמליצי או תמצאי לו סרטון, הרצאה, סיפור או סרט ביוטיוב.',
    'video_about = שאלה על סרטון שכבר הוזכר בשיחה (מה השם, תרגום השם, אורך, ערוץ, על מה הוא, האם הוא בעברית).',
    'video_play = המתקשר רוצה לשמוע, להשמיע, להפעיל או להוריד סרטון (הסרטון שהוזכר, או סרטון שהוא מתאר).',
    'recall = שאלה על שיחות קודמות או על פרטים שהמתקשר סיפר על עצמו.',
    'החזר JSON בלבד, בלי טקסט נוסף, בצורה:',
    '{"intent":"...","standalone":"השאלה כמשפט עצמאי וברור בעברית עם כל הפרטים מההקשר","search":"שאילתת חיפוש קצרה לאינטרנט אם intent=web","yt_he":"שאילתת חיפוש ביוטיוב בעברית אם צריך","yt_en":"אותה שאילתה באנגלית אם מתאים","min_minutes":0,"max_minutes":0,"play":"audio או video","continue_offer":false}',
    'play = "video" רק כשהמתקשר ביקש במפורש להוריד את הווידאו/הסרטון עצמו. continue_offer = true כשהמתקשר רק מסכים להמשיך את מה שהוצע לו בתשובה הקודמת.',
    'min_minutes/max_minutes רק אם ביקש אורך (למשל "כשעה" = min 40).',
    '',
    'הזמן עכשיו בישראל: ' + now,
    video ? 'הסרטון האחרון שהוזכר: ' + refLine(video) : 'לא הוזכר עדיין סרטון.',
    '',
    'הקשר:',
    context,
    '',
    'המתקשר אמר עכשיו: ' + utterance
  ].join('\n');
}

export function parsePlan(text) {
  const s = String(text || '');
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
    continueOffer: j.continue_offer === true
  };
}

const YT_WORD = /(?:יוטיוב|יויוטב|יוטוב|יו טיוב|youtube)/iu;
const VIDEO_WORD = /(?:סרטון|סרטונים|סרט|הרצאה|וידאו|וידיאו|דוקו|תיעודי)/u;

/** Used when every planner model is down: plain, conservative rules. */
export function heuristicPlan(utterance, { video = null } = {}) {
  const u = String(utterance || '').trim();
  const base = { standalone: u, search: u, ytHe: u.replace(YT_WORD, ' ').replace(/\s+/g, ' ').trim(), ytEn: '', minMinutes: 0, maxMinutes: 0, play: /(?:להוריד|תוריד|הורד).{0,20}(?:וידאו|וידיאו|סרטון עצמו)|כן לוידאו/u.test(u) ? 'video' : 'audio', continueOffer: false };
  if (/^בחרתי באפשרות/u.test(u)) return { ...base, intent: 'chat', continueOffer: true };
  if (/^(?:כן|כן בבקשה|בטח|בוודאי|תמשיכי|תמשיך|המשיכי|נמשיך|אחת|אחד|1|יאללה|סבבה|אוקיי|אוקי)[.!? ]*$/u.test(u)) return { ...base, intent: 'chat', continueOffer: true };
  if (/(?:זוכר|זוכרת|דיברנו|אמרתי לך|שאלתי אותך|בפעם הקודמת|בשיחה הקודמת)/u.test(u) && !VIDEO_WORD.test(u)) return { ...base, intent: 'recall' };
  if (video && /(?:תשמיע|תשמיעי|להשמיע|תפעיל|תפעילי|לשמוע את|תוריד|תורידי|להוריד)/u.test(u)) return { ...base, intent: 'video_play' };
  if (video && /(?:השם|איך קוראים|איך נקרא|כמה זמן|אורך|ארוך|הערוץ|באנגלית|בעברית|תתרגם|תתרגמי|על מה הוא|מה יש ב)/u.test(u) && (VIDEO_WORD.test(u) || /(?:אותו|שלו|זה)/u.test(u))) return { ...base, intent: 'video_about' };
  if ((YT_WORD.test(u) || VIDEO_WORD.test(u)) && /(?:תמליצ|ממליצ|מומלץ|תמצא|תמצאי|תחפש|תחפשי|אני מחפש|יש סרטון|איזה סרטון|תביא|תביאי)/u.test(u)) return { ...base, intent: 'video_find' };
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
export async function findVideos(queries, { minMinutes = 0, maxMinutes = 0, env, fetchImpl, proxy, regionCode = 'IL' } = {}) {
  const qs = [...new Set((queries || []).map(q => String(q || '').trim()).filter(q => q.length >= 2))].slice(0, 3);
  const duration = minMinutes >= 20 ? 'long' : (maxMinutes && maxMinutes <= 4) ? 'short' : (minMinutes >= 4 && (!maxMinutes || maxMinutes <= 20)) ? 'medium' : 'any';
  const lists = await Promise.allSettled(qs.map(q => youtubeGet('search', {
    part: 'snippet', q, type: 'video', maxResults: 15, safeSearch: 'strict', regionCode, relevanceLanguage: /[a-z]/i.test(q) && !/[֐-׿]/.test(q) ? 'en' : 'he', videoDuration: duration
  }, { env, fetchImpl, proxy })));
  const seen = new Set(), ids = [];
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
    description: decode(v.snippet?.description).slice(0, 600),
    publishedAt: v.snippet?.publishedAt || null,
    language: v.snippet?.defaultAudioLanguage || v.snippet?.defaultLanguage || '',
    durationSec: parseIsoDuration(v.contentDetails?.duration),
    viewCount: Number(v.statistics?.viewCount) || 0,
    ageRestricted: v.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted',
    live: v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none'
  })).filter(v => v.videoId && v.durationSec > 0 && !v.live && isSafeVideo(v));
  const order = new Map(ids.map((id, i) => [id, i]));
  if (minMinutes) videos = videos.filter(v => v.durationSec >= minMinutes * 60 * 0.75);
  if (maxMinutes) videos = videos.filter(v => v.durationSec <= maxMinutes * 60 * 1.25);
  // Relevance order from YouTube, nudged by popularity.
  videos.sort((a, b) => (order.get(a.videoId) - order.get(b.videoId)) - 4 * (Math.log10(b.viewCount + 10) - Math.log10(a.viewCount + 10)));
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
  'אל תמציא שמות, מספרים, מחירים, תאריכים, סרטונים, ערוצים או ציטוטים. כשאינך בטוחה בפרט, אמור זאת בפשטות.'
].join(' ');

export function teachingRule(lesson) {
  return 'כשהמתקשר רוצה ללמוד נושא (למשל תכנות), את המורה שלו כאן בטלפון: מלמדת שיעור אמיתי בשלבים, מסבירה מושג אחד או שניים בכל פעם בדוגמאות מהחיים, מתארת קוד במילים (למשל "כותבים פְּרִינְט, פותחים סוגריים...") ולא מפנה לאתרים, לקורסים או לסרטונים. בסוף כל שלב שאלי אם להמשיך לשלב הבא. ' +
    (lesson ? 'כרגע יש שיעור פעיל: ' + refLine(lesson) + '. אם המתקשר אומר כן או תמשיכי, המשיכי ישר לשלב הבא שלו בלי לחזור על ההקדמה. ' : '');
}

export function answerPrompt({ context, utterance, plan, now, instruction, extra = '', lesson = null }) {
  return [
    instruction,
    PHONE_STYLE,
    teachingRule(lesson),
    plan?.continueOffer ? 'המתקשר הסכים עכשיו להצעה מהתשובה הקודמת שלך. המשיכי בדיוק משם, בפירוט, בלי לשאול שוב מה הוא רוצה.' : '',
    'הזמן עכשיו בישראל: ' + now + '.',
    '',
    'הקשר השיחה:',
    context,
    extra ? '\n' + extra : '',
    '',
    'המתקשר אמר עכשיו: ' + utterance,
    plan?.standalone && plan.standalone !== utterance ? 'הכוונה שלו: ' + plan.standalone : '',
    '',
    'החזר אובייקט JSON תקין בלבד עם שדה "answer".'
  ].filter(x => x !== '').join('\n');
}

export function extractAnswer(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]); if (typeof j.answer === 'string' && j.answer.trim()) return j.answer.trim(); } catch {} }
  const loose = s.match(/"answer"\s*:\s*"([\s\S]*?)"\s*}?\s*$/);
  if (loose) return loose[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
  return s.replace(/^```(?:json)?|```$/g, '').trim();
}

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

/**
 * One full extension-3 turn. Returns { reply, ref?, handoff?, intent }.
 * deps: llm(prompt,{budgetMs,maxTokens,planner}) -> text
 *       webSearch(query,{timeoutMs}) -> [{title,url,snippet}]
 *       readPages(urls,{timeoutMs}) -> [{url,title,content}]
 *       findVideos(queries, opts) (defaults to the real one above)
 *       log
 */
export async function ext3Turn({ utterance, summary = '', prior = [], current = [], now = '' }, deps) {
  const log = deps.log || console;
  const video = activeVideo(current, prior);
  const lessonRef = activeLesson(current);
  const context = buildContext({ summary, prior, current, maxChars: 5200 });
  const smallContext = buildContext({ summary, prior, current, maxChars: 2600 });
  let plan = null;
  const t0 = Date.now();
  const rules = heuristicPlan(utterance, { video });
  const sure = rules.continueOffer || (video && ['video_play', 'video_about'].includes(rules.intent));
  if (sure) plan = rules;
  else try {
    plan = parsePlan(await deps.llm(plannerPrompt({ context: smallContext, utterance, now, video }), { budgetMs: 4500, maxTokens: 400, planner: true }));
  } catch (e) { log.warn?.('[EXT3_BRAIN] planner unavailable; using rules', { status: e?.status || 0 }); }
  if (!plan) plan = rules;
  // "a long video" means a long one even when no minutes were said.
  if ((plan.intent === 'video_find' || plan.intent === 'video_play') && !plan.minMinutes && /(?:ארוך|ארוכה|ארוכים|מלא|שעה)/u.test(utterance)) plan.minMinutes = /שעה/u.test(utterance) ? 40 : 20;
  // Asked about "the video" but none is on record: what was said is in the
  // conversation text, so it is a memory question, never a new search.
  if (!video && plan.intent === 'video_about') plan.intent = 'recall';
  // A video download only when the caller said so (the planner guessed
  // "video" for a plain "play it").
  plan.play = /(?:להוריד|תוריד|תורידי|הורד|הורדה|הורדת).{0,25}(?:וידאו|וידיאו|ווידאו|סרטון עצמו|הסרטון)|(?:וידאו|וידיאו|ווידאו).{0,15}(?:להוריד|תוריד|תורידי)|כן לוידאו/u.test(utterance) ? 'video' : 'audio';
  log.info?.('[EXT3_BRAIN] plan', { intent: plan.intent, standalone: plan.standalone.slice(0, 140), search: plan.search.slice(0, 100), yt: plan.ytHe.slice(0, 80), ms: Date.now() - t0 });

  // Sources leave less room for the conversation: the whole request must stay
  // small enough for the free fast models (they refuse big ones with 413).
  const ask = async (instruction, extra = '', { maxTokens = 1800, budgetMs = 13000, lesson = lessonRef, ctx = context } = {}) => {
    const raw = await deps.llm(answerPrompt({ context: ctx, utterance, plan, now, instruction, extra, lesson }), { budgetMs, maxTokens });
    const a = extractAnswer(raw);
    if (!a) throw Object.assign(new Error('empty answer'), { status: 502 });
    return a;
  };

  if (plan.intent === 'video_play') {
    let v = video;
    if (!v || (plan.ytHe && !/(?:אותו|אותה|הזה|הזאת|שהמלצת|שאמרת|שדיברנו)/u.test(utterance) && plan.ytHe.length > 8 && !String(v.title).includes(plan.ytHe))) {
      const found = await (deps.findVideos || findVideos)([plan.ytHe, plan.ytEn], { minMinutes: plan.minMinutes, maxMinutes: plan.maxMinutes, env: deps.env, fetchImpl: deps.fetchImpl, proxy: deps.youtubeProxy }).catch(() => []);
      if (found[0]) v = videoRef(found[0]);
    }
    if (!v) return { intent: plan.intent, reply: 'עוד לא בחרנו סרטון מסוים. ספר לי איזה סרטון אתה רוצה לשמוע, ואמצא לך אותו ביוטיוב.' };
    const mode = plan.play === 'video' ? 'video' : 'audio';
    return {
      intent: plan.intent, ref: v,
      handoff: { videoId: v.videoId, title: v.title, channelTitle: v.channelTitle, durationSec: v.durationSec, mode },
      reply: 'מעולה. אני מעבירה אותך עכשיו לשלוחת יוטיוב עם הסרטון ' + v.title + '. שם תשמע את פרטי הסרטון, ' +
        (mode === 'video' ? 'ותבחר הורדת וידאו, שגם תכין את השמע להשמעה בטלפון באותה הורדה.' : 'ותאשר את ההשמעה.')
    };
  }

  if (plan.intent === 'video_find') {
    const queries = [plan.ytHe || plan.standalone || utterance, plan.ytEn].filter(Boolean);
    let found = [];
    try { found = await (deps.findVideos || findVideos)(queries, { minMinutes: plan.minMinutes, maxMinutes: plan.maxMinutes, env: deps.env, fetchImpl: deps.fetchImpl, proxy: deps.youtubeProxy }); }
    catch (e) { log.warn?.('[EXT3_BRAIN] YouTube search failed', { status: e?.status || 0, message: String(e?.message || e).slice(0, 120) }); }
    if (!found.length) return { intent: plan.intent, reply: 'חיפשתי ביוטיוב ולא מצאתי סרטון שמתאים בדיוק למה שביקשת. אפשר לתאר לי במילים אחרות את הנושא, או לומר אם חשוב לך שיהיה בעברית או באורך מסוים, ואחפש שוב.' };
    const instruction = 'המתקשר ביקש המלצה על סרטון. לפניך רשימת סרטונים אמיתיים שנמצאו עכשיו ביוטיוב, עם הכותרת המדויקת, הערוץ, האורך בדקות, מספר הצפיות והתיאור. ' +
      'בחרי את הסרטון המתאים ביותר לבקשה: קודם שיתאים בדיוק לנושא, לסוג, לשפה ולאורך שביקש, ובין המתאימים עדיף סרטון איכותי ופופולרי עם הרבה צפיות (ואפשר להזכיר עוד אחד או שניים כחלופה). אסור להמליץ על סרטון שאינו ברשימה, ואסור לשנות את הכותרת, הערוץ או האורך. ' +
      'בתשובה אמרי את הכותרת המדויקת כפי שהיא, ואם היא בשפה זרה גם תרגום שלה לעברית, את שם הערוץ, את האורך ואת מספר הצפיות, ותארי בעברית, במילים שלך ובמשפטים זורמים, על מה הסרטון רק לפי התיאור שלו, בלי להקריא את התיאור באנגלית ובלי להמציא תוכן. ' +
      'סיימי בכך שאפשר לומר "תשמיעי לי אותו" כדי לשמוע אותו בשלוחת יוטיוב, או "תורידי את הווידאו". ' +
      'החזר JSON בלבד בצורה {"pick":מספר i של הסרטון הנבחר,"answer":"התשובה למתקשר"}.';
    let pick = 0, reply = '';
    try {
      const raw = await deps.llm(answerPrompt({ context: smallContext, utterance, plan, now, instruction, extra: 'סרטונים שנמצאו:\n' + candidatesText(found.slice(0, 8)) }), { budgetMs: 12000, maxTokens: 1400 });
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : null;
      if (Number.isInteger(j?.pick) && found[j.pick]) pick = j.pick;
      reply = String(j?.answer || '').trim();
    } catch (e) { log.warn?.('[EXT3_BRAIN] video pick unavailable; using the top result', { status: e?.status || 0 }); }
    const v = found[pick];
    // The exact title must be in the spoken answer; otherwise the facts are said plainly.
    if (!reply || !reply.includes(v.title.slice(0, Math.min(20, v.title.length)))) {
      reply = 'מצאתי לך ביוטיוב את הסרטון ' + v.title + ', בערוץ ' + v.channelTitle + '. אורכו ' + spokenDuration(v.durationSec) + (spokenViews(v.viewCount) ? ', ויש לו ' + spokenViews(v.viewCount) : '') + '. ' +
        (v.description ? 'לפי התיאור שלו: ' + clip(v.description, 260) + ' ' : '') +
        'אם תרצה לשמוע אותו, אמור תשמיעי לי אותו, ואעביר אותך לשלוחת יוטיוב. אפשר גם לומר תורידי את הווידאו.';
    }
    return { intent: plan.intent, ref: videoRef(v), reply };
  }

  if (plan.intent === 'video_about' && video) {
    const facts = 'פרטי הסרטון האמיתיים (מיוטיוב): כותרת מדויקת: "' + video.title + '". ערוץ: ' + (video.channelTitle || 'לא ידוע') + '. אורך: ' + (spokenDuration(video.durationSec) || 'לא ידוע') +
      '. צפיות: ' + (video.viewCount || 'לא ידוע') + '. פורסם: ' + String(video.publishedAt || '').slice(0, 10) + '. שפה: ' + (video.language || 'לא ידוע') + '.' + (deps.videoDescription ? ' תיאור: ' + clip(await deps.videoDescription(video.videoId).catch(() => ''), 700) : '');
    const reply = await ask('המתקשר שואל על הסרטון שכבר הוזכר. ענה רק מתוך הפרטים האמיתיים שלמטה. כשמבקשים את השם: אמרי את הכותרת המדויקת כפי שהיא, ואם היא בשפה זרה גם תרגום מדויק לעברית, ואם מבקשים לאיית או להגיד לאט, אמרי אותה מילה אחר מילה. אל תמציאי תוכן שלא מופיע בתיאור.', facts, { maxTokens: 900, budgetMs: 9000 });
    return { intent: plan.intent, ref: video, reply };
  }

  if (plan.intent === 'web') {
    const q1 = plan.search || plan.standalone || utterance;
    const queries = [...new Set([q1, plan.standalone].filter(Boolean))].slice(0, 2);
    const sets = await Promise.allSettled(queries.map(q => deps.webSearch(q, { timeoutMs: 4500 })));
    const seen = new Set(), results = [];
    for (const s of sets) for (const r of (s.status === 'fulfilled' ? s.value || [] : [])) {
      const key = String(r.url || '').replace(/[#?].*$/, '');
      if (!r.url || seen.has(key)) continue;
      seen.add(key); results.push(r);
    }
    if (!results.length) {
      log.warn?.('[EXT3_BRAIN] web search found nothing; answering from knowledge with a caveat');
      const reply = await ask('חיפשת באינטרנט ולא נמצאו מקורות. ענה מהידע הכללי שלך רק על מה שאת בטוחה בו, ואמרי בפירוש שלא הצלחת לאמת עכשיו את הפרטים העדכניים.', '', { maxTokens: 1400 });
      return { intent: plan.intent, reply };
    }
    let pages = [];
    if (deps.readPages) {
      const urls = results.slice(0, 4).map(r => r.url).filter(u => !/youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com/i.test(u)).slice(0, 3);
      pages = await Promise.race([deps.readPages(urls, { timeoutMs: 5500 }).catch(() => []), new Promise(r => setTimeout(() => r([]), 5200).unref?.())]);
    }
    const byUrl = new Map(pages.map(p => [String(p.url || '').replace(/[#?].*$/, ''), p]));
    let budget = 5200;
    const sourceText = results.slice(0, 8).map((r, i) => {
      const page = byUrl.get(String(r.url).replace(/[#?].*$/, ''));
      const body = page?.content ? clip(page.content, Math.min(2200, Math.max(300, budget))) : clip(r.snippet, 420);
      budget -= body.length;
      return 'מקור ' + (i + 1) + ': ' + clip(r.title, 120) + ' (' + String(r.url).replace(/^https?:\/\//, '').slice(0, 60) + ')\n' + body;
    }).join('\n\n').slice(0, 6500);
    log.info?.('[EXT3_BRAIN] web research', { queries, results: results.length, pagesRead: pages.length, sourceChars: sourceText.length });
    const reply = await ask('המתקשר צריך מידע עדכני ומדויק. לפניך מקורות אמיתיים מהאינטרנט שנאספו ונקראו עכשיו לשאלה הזאת בלבד. אל תערבבי בתשובה מידע מתשובות קודמות בשיחה שאינו קשור לשאלה הזאת. ענה בהרחבה ובפירוט רק לפי המקורות: עובדות, מספרים, שמות ותאריכים בדיוק כפי שכתובים בהם. כשהמקורות סותרים, אמרי זאת. כשהמקורות לא עונים על חלק מהשאלה, אמרי שלא מצאת את החלק הזה. אל תקריאי כתובות אתרים ואל תאמרי "מקור 1".', 'מקורות:\n' + sourceText, { maxTokens: 1800, budgetMs: 14000, ctx: smallContext });
    return { intent: plan.intent, reply };
  }

  if (plan.intent === 'recall') {
    const reply = await ask('המתקשר שואל על שיחות קודמות או על עצמו. ענה רק מתוך הקשר השיחה והסיכום. כשהוא שואל פרט אחד, ענה עליו בפשטות. כשהוא שואל מה דיברנו, סכמי את הנושאים העיקריים לפי הסדר, עם הפרטים החשובים (למשל שם מדויק של סרטון שהומלץ). אם פרט לא מופיע, אמרי בכנות שאינך זוכרת אותו.', '', { maxTokens: 1000, budgetMs: 10000 });
    return { intent: plan.intent, reply };
  }

  // chat (talk, explanation, teaching, continuing an offer)
  const lessonWanted = looksLikeLessonRequest(utterance) || (plan.continueOffer && lessonRef);
  const reply = await ask('את עוזרת חכמה ונבונה בטלפון, עם ידע רחב בכל תחום. עני על מה שהמתקשר אמר עכשיו, בהמשך טבעי לשיחה.', '', { maxTokens: 2000, budgetMs: 13000 });
  let ref = null;
  if (lessonWanted) {
    const topic = lessonRef?.topic || lessonTopic(utterance) || lessonTopic(plan.standalone) || 'הנושא שביקש';
    ref = { type: 'lesson', topic, step: (lessonRef && lessonRef.topic === topic ? Number(lessonRef.step) || 1 : 0) + 1 };
  }
  return { intent: plan.intent, reply, ref };
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
