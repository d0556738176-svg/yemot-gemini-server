import { extractExplicitLocation } from './business-location.js';
import { buildLocalBusinessQueries, filterLocalBusinessResults } from './local-business-search.js';

export const isCorrection = text => /(?:לא\s+הבנת|לא\s+ענית|לא\s+זה|זה\s+לא\s+מה|טעית|מה\s+ששאלתי|מה\s+שאמרתי)/u.test(String(text || ''));

export function createBranch1Search(search, {ttlMs=30000, now=Date.now}={}) {
  const cache=new Map();
  return (query, options={}) => {
    const key=JSON.stringify([String(query).trim(),Boolean(options.deep)]);
    const hit=cache.get(key);
    if (hit && hit.expires>now()) return hit.promise;
    if (cache.size>=100) cache.delete(cache.keys().next().value);
    const entry={expires:now()+ttlMs};
    entry.promise=Promise.resolve().then(()=>search(query,options)).then(results=>{
      if (!results?.length) cache.delete(key);
      return results;
    }, error=>{ if(cache.get(key)===entry) cache.delete(key); throw error; });
    cache.set(key,entry);
    return entry.promise;
  };
}

export function resolveBranch1Question(text, history = []) {
  let q = String(text || '').trim();
  // Only repair known locality transcription in an explicit neighborhood context.
  // A truncated city is ambiguous: ask rather than silently choose a city.
  if (/רמות\s+דוד/u.test(q)) {
    q = q.replace(/(?:קריאת|קריית|קרית|קירית)\s+(?:גת|גט|גד)/gu, 'קריית גת');
  }
  const last = history.at(-1);
  if (last && isBranch1LocalRequest(last.resolvedQuestion || last.user || '') &&
      !extractExplicitLocation(last.resolvedQuestion || last.user).city &&
      extractExplicitLocation(q).city && q.length < 60 && !/(הופעה|אירוע|שעות|טלפון)/u.test(q)) {
    q = (last.resolvedQuestion || last.user) + ' ' + q;
  }
  if (isCorrection(q)) {
    const previous = [...history].reverse().find(t => t.user && !isCorrection(t.user));
    // A correction naming a fresh location/category must be processed as spoken.
    const named = extractExplicitLocation(q);
    if (!named.city && !named.area && !/(?:התכוונתי|אלא|ביקשתי)\s+.{3,}/u.test(q) && previous) {
      q = previous.resolvedQuestion || previous.user;
    }
  }
  return q;
}

export function isBranch1LocalRequest(q) {
  if (/(שעות|מתי פתוח|מתי נסגר|טלפון|מוקד)/u.test(q)) return false;
  return /(חנות|חנויות|חניות|עסקים|מכולת|סופרמרקט|מסעדות|מסעדה)/u.test(q) && !!extractExplicitLocation(q).area;
}

export function isBranch1EventRequest(q) {
  return /(פעילות|פעילויות|הופעה|הופעות|אירוע|אירועים|תרבותי|תרבותית|מופע|מופעים)/u.test(q) &&
    !/(מה זה|מהי|מהו|הסבר|הגדר)/u.test(q);
}

export function filterBranch1Results(question, results) {
  const loc=extractExplicitLocation(question);
  const normalize=text=>String(text||'').toLowerCase().replace(/קרית|קירית/gu,'קריית').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/gu,' ');
  const stop=new Set('איזה אילו מה מי איך למה כמה מתי איפה יש את של לי אני אתה הוא היא בבקשה חפש תחפש תמצא תבדוק מידע פרטים היום עכשיו באינטרנט ברשת תן רוצה צריך אפשר'.split(' '));
  const locationWords=new Set(normalize([loc.city,loc.area].join(' ')).trim().split(' '));
  const words=normalize(question).split(' ').filter(w=>w.length>2&&!stop.has(w)&&!locationWords.has(w));
  return (results||[]).filter(r=>{
    const text=normalize([r.title,r.snippet].join(' '));
    if(loc.city&&!text.includes(normalize(loc.city)))return false;
    if(loc.area&&!text.includes(normalize(loc.area)))return false;
    return !words.length||words.some(w=>text.includes(w)|| (w.length>3&&/^[בלמהו]/u.test(w)&&text.includes(w.slice(1))));
  });
}

// Keep each TTS item short and remove protocol/control/emoji characters. Preserve
// the whole response through multiple text items; never silently drop its tail.
export function branch1SpeechItems(text, size = 400) {
  const clean = String(text || '').normalize('NFC')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{So}]/gu, ' ')
    .replace(/[|&<>\[\]{}_*#\\]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  const words = clean.split(' ');
  const chunks = [];
  let chunk = '';
  for (const word of words) {
    if (chunk && chunk.length + word.length + 1 > size) { chunks.push(chunk); chunk = ''; }
    if (word.length > size) {
      if (chunk) { chunks.push(chunk); chunk = ''; }
      for (let i = 0; i < word.length; i += size) chunks.push(word.slice(i, i + size));
    } else chunk += (chunk ? ' ' : '') + word;
  }
  if (chunk) chunks.push(chunk);
  return (chunks.length ? chunks : ['אני איתך.']).map(data => ({ type: 'text', data }));
}

export async function answerBranch1Local(q, search) {
  const loc = extractExplicitLocation(q);
  if (!loc.city) return 'באיזו עיר נמצאת השכונה ' + loc.area + '? שם העיר לא זוהה בבירור.';
  const queries = buildLocalBusinessQueries(q, loc).slice(0, 3);
  const responses = await Promise.allSettled(queries.map(query => search(query, { timeoutMs: 2200 })));
  const results = responses.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const exact = filterLocalBusinessResults(results, loc).filter(r => {
    const text = [r.title, r.snippet].join(' ');
    // Reports about shops and protests are not business listings.
    return !/(פשקוויל|מחאה|אסונות|וואטסאפ|חרם)/u.test(text) &&
      /(?:כתובת|רחוב|טלפון|מכולת|מסעדה|סופרמרקט|חנות|חנויות)/u.test(text);
  });
  const unique = [...new Map(exact.map(r => [r.url, r])).values()].slice(0, 3);
  if (!unique.length) return 'לא הצלחתי לאמת כרגע שמות וכתובות של חנויות בתוך ' + loc.area + ' ב' + loc.city + '. לא מצאתי רשומת עסק שמתאימה למיקום שביקשת.';
  return 'ברשומות שמצאתי עבור ' + loc.area + ' ב' + loc.city + ': ' +
    unique.map(r => String(r.title) + '. ' + String(r.snippet || '').slice(0, 240)).join('. ') +
    '. אלה רשומות ברשת; פעילות החנויות ושעות הפתיחה לא אומתו.';
}

export async function answerBranch1Events(q, search) {
  const city = extractExplicitLocation(q).city;
  if (!city) return 'באיזו עיר ובאיזה יום לחפש הופעה או פעילות תרבות?';
  // Do not assume a date for an open-ended request, or read an old event snippet.
  if (!/(היום|מחר|הערב|השבוע|סוף השבוע|\d{1,2}[./]\d{1,2})/u.test(q)) {
    return 'לחפש לך הופעה או פעילות תרבות ב' + city + ' להיום, למחר או להמשך השבוע?';
  }
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p => [p.type,p.value]));
  const today = parts.year + '-' + parts.month + '-' + parts.day;
  const dayMs = 86400000;
  const start = Date.parse(today + 'T00:00:00Z') + (/מחר/u.test(q) ? dayMs : 0);
  const end = start + (/השבוע/u.test(q) ? 7 : 1) * dayMs;
  const responses = await Promise.allSettled([
    q + ' ' + today + ' לוח אירועים רשמי תאריך שעה מקום',
    city + ' מופעים לוח אירועים ' + parts.month + ' ' + parts.year
  ].map(query => search(query, {timeoutMs:2200})));
  const results = responses.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const dated = results.filter(r => {
    const text = [r.title, r.snippet].join(' ');
    if (!text.includes(city) || !/(מופע|הופעה|קונצרט|הצגה|אירוע)/u.test(text)) return false;
    // A publication timestamp by itself is insufficient event evidence.
    if (/(פורסם|עודכן|תאריך פרסום)/u.test(text) && !/(מועד האירוע|תאריך האירוע|יתקיים|תתקיים)/u.test(text)) return false;
    const dates = [...text.matchAll(/(?:\b(20\d{2})-(\d{2})-(\d{2})\b|\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b)/gu)];
    return dates.some(m => {
      const year=m[1] || m[6], month=m[2] || m[5], day=m[3] || m[4];
      const stamp=Date.UTC(Number(year), Number(month)-1, Number(day));
      const d=new Date(stamp);
      return d.getUTCMonth()===Number(month)-1 && d.getUTCDate()===Number(day) && stamp>=start && stamp<end;
    });
  });
  const unique = [...new Map(dated.map(r => [r.url,r])).values()].slice(0,3);
  if (!unique.length) return 'לא הצלחתי לאמת הופעה או פעילות תרבות ב' + city + ' לתאריך שביקשת. לא אציג פרסום ישן כאירוע עדכני.';
  return 'בלוחות שמצאתי מופיעים הפרסומים הבאים עם תאריך בטווח שביקשת: ' + unique.map(r => {
    let host=''; try {host=new URL(r.url).hostname;} catch {}
    return r.title + '. ' + String(r.snippet || '').slice(0,350) + (host ? '. מקור ' + host : '');
  }).join('. ') + '. יש לאמת מול המארגן שהאירוע מתקיים ושנותרו מקומות.';
}
