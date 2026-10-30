import { findBranch1Events } from './branch1-events.js';
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
  let q = String(text || '').trim()
    .replace(/(^|[\s,])([בלמ]?)(?:בת|ביית|ביט)\s+שמש(?=$|[\s,.?!])/gu,'$1$2בית שמש');
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
  const lastQuestion=last?.resolvedQuestion || last?.user || '';
  const dateOnly=/^(?:כן[, ]*)?(?:להיום|היום|מחר|למחר|הערב|השבוע|בסוף השבוע|סוף השבוע|\d{1,2}[./]\d{1,2}(?:[./]20\d{2})?)[?.! ]*$/u.test(q);
  const dateQuestion=/^(?:אז[, ]*)?(?:ו?מה\s+(?:יש|קורה|לגבי)|ו?מה\s+עם|ואילו אירועים|ואיזה אירועים).{0,20}(?:היום|מחר|הערב|השבוע|סוף השבוע)[?.! ]*$/u.test(q);
  const spokenInstructions=q.length<160 && /אם\s+(?:י?שאל|תשאל)|(?:ענה|אענה|אני)\s+רק/u.test(q);
  // A caller may combine a short date reply and a new date question in one
  // recording. The final requested date wins; never search the instruction text.
  const temporal=[...q.matchAll(/מחרתיים|בסוף השבוע|סוף השבוע|למחר|להיום|היום|מחר|הערב|השבוע/gu)].at(-1)?.[0];
  if((dateOnly||dateQuestion||spokenInstructions) && isBranch1EventRequest(lastQuestion) && !extractExplicitLocation(q).city) {
    const cleanTopic=lastQuestion.replace(/(?:מחרתיים|בסוף השבוע|סוף השבוע|למחר|להיום|היום|מחר|הערב|השבוע)/gu,'').trim();
    if(temporal)q=cleanTopic+' '+temporal;
  }
  const namedLocation=extractExplicitLocation(q);
  if(namedLocation.city && namedLocation.area && !/(חנות|חנויות|עסקים|מכולת|מסעדה|אירוע|מופע|הופעה|טלפון|שעות)/u.test(q) &&
      /(חנות|חנויות|עסקים|מכולת|מסעדה)/u.test(lastQuestion)) {
    q=lastQuestion.replace(/(?:ב)?(?:רמות דוד|קריית גת|קרית גת)/gu,'').trim()+' '+q;
  }
  if (isCorrection(q)) {
    const previous = [...history].reverse().find(t => t.user && !isCorrection(t.user));
    // A correction naming a fresh location/category must be processed as spoken.
    const named = extractExplicitLocation(q);
    const explicitWebsite=/https?:\/\/|(?:האתר|אתר)\s+(?!(?:הזה|זה|שפתחת|שנפתח)(?:\s|$))\S+/u.test(q);
    if (!named.city && !named.area && !explicitWebsite && !/(?:התכוונתי|אלא|ביקשתי)\s+.{3,}/u.test(q) && previous) {
      q = previous.resolvedQuestion || previous.user;
    }
  }
  return q;
}

export function isBranch1LocalRequest(q) {
  if (/(שעות|מתי פתוח|מתי נסגר|טלפון|מוקד)/u.test(q)) return false;
  return /(חנות|חנויות|חניות|עסקים|מכולת|סופרמרקט|מסעדות|מסעדה)/u.test(q) && !!extractExplicitLocation(q).area;
}

export function branch1FollowUpHistory(q, history=[]) {
  if(!history.length)return '';
  const contextual=/^(?:כן[, ]*)?(?:היום|מחר|הערב|השבוע|תמשיך|המשך|עוד|תסביר|תרחיב|תפרט|מה הכוונה|למה|איך זה|איפה זה|מתי זה|מה השעות|מה יש|מה קורה|ומה|כמה זה|הראשון|השני|השלישי|זה|אותו|אותה)(?:\s|[?!.,]|$)/u.test(q) || isCorrection(q);
  // A short, elliptical question that leans on what was just said — "אז מה
  // המתכון?", "מה עם השני?", "אז נו?", "ובלי זה?", "טוב, ומה עכשיו?". These lost
  // their topic before, so the caller heard "מה אתה מחפש?" instead of an answer.
  const shortElliptical = q.length <= 55 && (
    /^(?:אז|נו|טוב|אוקיי|אוקי|בסדר|יופי)[, ]*(?:אז|נו|מה|ומה|איך|למה|כמה|מתי|איפה|תן|תגיד)?(?:\s|[?!.,]|$)/u.test(q) ||
    /^(?:אז\s*)?(?:מה|ומה|איזה|איזו)\s+(?:ה|עם|לגבי|בדיוק|אם כן|הכי)/u.test(q) ||
    /^(?:בלי|עם|ומה עם|אבל|רק)(?:\s|$)/u.test(q)
  );
  const details=/(?:מאיזה מקור|מה המקור|פרטים על (?:האירוע|החנות|הדבר|הפרט) הראשון|הדף שפתחת)/u.test(q);
  if(!contextual&&!shortElliptical&&!details)return '';
  return history.slice(-4).map((t,i)=>'תור '+(i+1)+' — מתקשר: '+(t.resolvedQuestion||t.user)+'\nתשובה: '+t.assistant).join('\n\n');
}

export function branch1Clarification(q) {
  if(extractExplicitLocation(q).city||isBranch1EventRequest(q))return '';
  if(/^(?:ו?מה\s+(?:יש|קורה)|ו?מה\s+עם)\s+(?:היום|מחר|הערב|השבוע)[?.! ]*$/u.test(q))return 'על איזה נושא ובאיזו עיר לחפש לך מידע להיום או למחר?';
  if(q.length<160&&/אם\s+(?:י?שאל|תשאל).{0,35}יום/u.test(q))return 'לאיזה נושא ולאיזה יום התכוונת? אפשר לומר את הבקשה עצמה, ואחפש אותה.';
  return '';
}

export function isBranch1EventRequest(q) {
  if (/(שעות\s+(?:ה)?פעילות|שעות\s+פתיחה|מתי\s+(?:פתוח|נסגר)|טלפון|שירות לקוחות)/u.test(q)) return false;
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
  const wantsOpen=/(פתוח|פתוחה|פתוחים|פתוחות).{0,10}(עכשיו|היום)/u.test(q);
  return (wantsOpen?'לא אומת איזו חנות פתוחה עכשיו. ברשומות שמצאתי עבור ':'ברשומות שמצאתי עבור ') + loc.area + ' ב' + loc.city + ': ' +
    unique.map(r => String(r.title) + '. ' + String(r.snippet || '').slice(0, 240)).join('. ') +
    '. אלה רשומות ברשת; פעילות החנויות ושעות הפתיחה לא אומתו.';
}

export async function answerBranch1Events(q, search, options={}) {
  return findBranch1Events(q,search,options);
}
