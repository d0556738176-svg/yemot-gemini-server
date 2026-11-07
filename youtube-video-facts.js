// Facts about a selected video, spoken before the caller confirms playback:
// length, how long ago it was published, and how many views it has.
// One YouTube Data API call (videos.list, 1 quota unit) returns all three.
import { parseIsoDurationSeconds } from './youtube-engine-select.js';

export async function fetchVideoFacts(videoId, env = process.env, fetchImpl = fetch) {
  const key = String(env.YOUTUBE_API_KEY || '').trim();
  if (!key || !/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) return null;
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'contentDetails,snippet,statistics');
  url.searchParams.set('id', String(videoId));
  url.searchParams.set('key', key);
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(Number(env.YOUTUBE_DURATION_TIMEOUT_MS || 8000)) });
  if (!r.ok) return null;
  const item = (await r.json().catch(() => null))?.items?.[0];
  if (!item) return null;
  const views = Number(item.statistics?.viewCount);
  return {
    durationSeconds: parseIsoDurationSeconds(item.contentDetails?.duration),
    publishedAt: item.snippet?.publishedAt || null,
    // A channel can hide its view count; then nothing is said about views.
    viewCount: Number.isFinite(views) && views >= 0 ? views : null,
    title: item.snippet?.title || null,
    channel: item.snippet?.channelTitle || null,
    description: item.snippet?.description || null,
    tags: Array.isArray(item.snippet?.tags) ? item.snippet.tags : null,
    categoryId: item.snippet?.categoryId || null,
    // Spoken language as the channel declared it (often missing).
    audioLanguage: String(item.snippet?.defaultAudioLanguage || item.snippet?.defaultLanguage || '').toLowerCase() || null,
    hasCaptions: item.contentDetails?.caption === 'true',
    regionAllowed: Array.isArray(item.contentDetails?.regionRestriction?.allowed) ? item.contentDetails.regionRestriction.allowed : null,
    regionBlocked: Array.isArray(item.contentDetails?.regionRestriction?.blocked) ? item.contentDetails.regionRestriction.blocked : null,
  };
}

// The download engine fetches from servers outside Israel and has no way to
// choose a country. A video its owner limited to certain countries (e.g. only
// IL) is answered "This video is unavailable" there; verified 04.11 on two such
// videos (regionRestriction.allowed = [IL, PS]). Knowing this in advance lets
// the caller hear the real reason instead of a failed attempt.
export function engineCannotReach(facts, env = process.env) {
  const countries = String(env.BRANCH2_ENGINE_COUNTRIES || 'US').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
  if (!facts || !countries.length) return false;
  if (Array.isArray(facts.regionAllowed) && !facts.regionAllowed.some(c => countries.includes(String(c).toUpperCase()))) return true;
  if (Array.isArray(facts.regionBlocked) && countries.every(c => facts.regionBlocked.map(x => String(x).toUpperCase()).includes(c))) return true;
  return false;
}

// "לפני 3 שנים", "לפני חודשיים", "אתמול", "היום" — natural spoken Hebrew.
export function publishedAgoHebrew(publishedAt, now = Date.now()) {
  const t = Date.parse(publishedAt || '');
  if (!Number.isFinite(t) || t > now + 3600000) return '';
  const hours = (now - t) / 3600000, days = hours / 24;
  const pick = (n, one, two, many) => n === 1 ? one : n === 2 ? two : n + ' ' + many;
  if (hours < 1) return 'לפני פחות משעה';
  if (hours < 24) return 'לפני ' + pick(Math.floor(hours), 'שעה', 'שעתיים', 'שעות');
  if (days < 2) return 'אתמול';
  if (days < 7) return 'לפני ' + pick(Math.floor(days), 'יום', 'יומיים', 'ימים');
  if (days < 30) return 'לפני ' + pick(Math.floor(days / 7), 'שבוע', 'שבועיים', 'שבועות');
  if (days < 365) return 'לפני ' + pick(Math.max(1, Math.floor(days / 30.44)), 'חודש', 'חודשיים', 'חודשים');
  return 'לפני ' + pick(Math.floor(days / 365.25), 'שנה', 'שנתיים', 'שנים');
}

// Spoken view count: exact below 1,000, then rounded the way people say it
// ("בערך 12 אלף", "בערך מיליון ושלוש מאות אלף", "בערך 45 מיליון"). No hyphens:
// the phone text filter turns "-" into a space, which would split "כ-" apart.
const HUNDREDS = ['', 'מאה', 'מאתיים', 'שלוש מאות', 'ארבע מאות', 'חמש מאות', 'שש מאות', 'שבע מאות', 'שמונה מאות', 'תשע מאות'];
export function viewsHebrew(views) {
  if (views === null || views === undefined || views === '') return '';
  const v = Math.floor(Number(views));
  if (!Number.isFinite(v) || v < 0) return '';
  if (v === 0) return 'אין לו עדיין צפיות';
  if (v === 1) return 'יש לו צפייה אחת';
  if (v < 1000) return 'יש לו ' + v + ' צפיות';
  if (v < 1000000) {
    const k = Math.round(v / 1000);
    if (k >= 1000) return viewsHebrew(1000000);
    return 'יש לו בערך ' + (k === 1 ? 'אלף' : k === 2 ? 'אלפיים' : k + ' אלף') + ' צפיות';
  }
  if (v < 1000000000) {
    const m = Math.floor(v / 1000000), rest = Math.round((v % 1000000) / 100000);
    const mm = m === 1 ? 'מיליון' : m === 2 ? 'שני מיליון' : m + ' מיליון';
    if (m < 10 && rest > 0 && rest < 10) return 'יש לו בערך ' + mm + ' ו' + HUNDREDS[rest] + ' אלף צפיות';
    return 'יש לו בערך ' + mm + ' צפיות';
  }
  const b = Math.round(v / 1000000000);
  return 'יש לו בערך ' + (b === 1 ? 'מיליארד' : b + ' מיליארד') + ' צפיות';
}

// The video's spoken language, as best known before downloading: what the
// channel declared, else a guess from the title (Hebrew letters -> Hebrew,
// mostly English words -> English). Returns { code, name } or null.
const LANG_NAMES = { he: 'עברית', iw: 'עברית', en: 'אנגלית', yi: 'יידיש', ar: 'ערבית', ru: 'רוסית', fr: 'צרפתית', es: 'ספרדית', de: 'גרמנית', it: 'איטלקית', pt: 'פורטוגזית', am: 'אמהרית', uk: 'אוקראינית', zh: 'סינית', ja: 'יפנית', hi: 'הינדית', tr: 'טורקית', nl: 'הולנדית', pl: 'פולנית' };
export function videoLanguage(facts, title = '') {
  const declared = String(facts?.audioLanguage || '').split('-')[0];
  if (declared && LANG_NAMES[declared]) return { code: declared === 'iw' ? 'he' : declared, name: LANG_NAMES[declared], declared: true };
  const t = String(facts?.title || title || '');
  const heb = (t.match(/[\u05d0-\u05ea]/g) || []).length, lat = (t.match(/[A-Za-z]/g) || []).length;
  if (/[\u05d0-\u05ea]/.test(t) && /\b(?:פון|דער|דאס|איז|ניט|אונז|זיין)\b/.test(t)) return { code: 'yi', name: 'יידיש', declared: false };
  if (heb > lat) return { code: 'he', name: 'עברית', declared: false };
  if (lat > 8 && heb === 0) return { code: 'en', name: 'אנגלית', declared: false };
  return null;
}
