// A named business's opening hours from its Google Maps listing (owner, 28.11):
// "Is Rami Levy in the Hasdera mall in Beit Shemesh open now?" got no answer
// because the open map (OpenStreetMap) has no hours for most shops and the web
// pages rarely state one branch's hours. Google's listing does, for almost every
// business; it is read through Serper's maps search (one request, cached), the
// listing that matches the business and the town is chosen, and "open now /
// until when / when it opens" is worked out here for this minute, Israel time.

import { spokenTime } from './place-tools.js';

const DAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const SPOKEN_DAY = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];

const cache = new Map();
function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = Promise.resolve().then(fn).catch(e => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return value;
}

const plain = s => String(s || '').toLowerCase().replace(/[״"׳'`\-–־.,()]/g, ' ').replace(/\s+/g, ' ').trim();
// "+972 2 561 3580" -> "02-561-3580"; "..., בית שמש, 9903024, ישראל" -> "..., בית שמש".
export const localPhone = p => { const d = String(p || '').replace(/[^\d+]/g, ''); const m = d.match(/^\+?972(\d{1,2})(\d{3})(\d{4})$/); return m ? '0' + m[1] + '-' + m[2] + '-' + m[3] : String(p || ''); };
export const cleanAddress = a => String(a || '').replace(/,?\s*(?:ישראל|Israel)\s*$/u, '').replace(/,\s*\d{5,7}(?=,|$)/g, '').trim();
const STOP = new Set(['סניף', 'חנות', 'הסניף', 'החנות', 'של', 'את', 'ב', 'ה', 'פתוח', 'פתוחה', 'עכשיו', 'היום', 'קניון', 'הקניון', 'מרכז', 'שעות', 'פתיחה']);
const wordsOf = s => plain(s).split(' ').filter(w => w.length >= 2 && !STOP.has(w));
// "ברמי" / "הרמי" / "לרמי" still match "רמי".
const has = (hay, w) => hay.includes(w) || (w.length > 3 && /^[בהלו]/u.test(w) && hay.includes(w.slice(1)));

/** "7 AM–11 PM" / "07:00–23:00" / "8:30AM-1PM, 4–7PM" → [[startMin, endMin], ...]; [] = closed; null = unknown. */
export function parseDayHours(text) {
  const t = String(text || '').replace(/ | | /g, ' ').trim();
  if (!t) return null;
  if (/closed|סגור/i.test(t) && !/\d/.test(t)) return [];
  if (/24\s*(?:hours|שעות)|open 24|פתוח 24|מסביב לשעון/i.test(t)) return [[0, 1440]];
  const out = [];
  for (const part of t.split(/[,;،]|\s+ו(?=\d)/u)) {
    const m = part.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|לפנה"?צ|אחה"?צ|בבוקר|בערב)?\s*[–—\-עד]+\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|לפנה"?צ|אחה"?צ|בבוקר|בערב)?/iu);
    if (!m) continue;
    const pm = x => /pm|אחה|בערב/i.test(x || ''), am = x => /am|לפנה|בבוקר/i.test(x || '');
    let h1 = Number(m[1]), h2 = Number(m[4]);
    const m1 = Number(m[2] || 0), m2 = Number(m[5] || 0);
    // "4–7 PM": the first time shares the second's half of the day when it has none.
    const s1 = m[3] || (m[6] && h1 <= h2 ? m[6] : ''), s2 = m[6] || '';
    if (pm(s1) && h1 < 12) h1 += 12; if (am(s1) && h1 === 12) h1 = 0;
    if (pm(s2) && h2 < 12) h2 += 12; if (am(s2) && h2 === 12) h2 = 0;
    let a = h1 * 60 + m1, b = h2 * 60 + m2;
    if (b <= a) b += 1440; // past midnight (Saturday night 8 PM–1 AM)
    if (a < 1440) out.push([a, b]);
  }
  return out.length ? out : null;
}

/** Google's openingHours object (English or Hebrew day names) → week[0..6] of ranges (null = unknown). */
export function parseWeek(openingHours) {
  const week = Array(7).fill(null);
  if (!openingHours || typeof openingHours !== 'object') return week;
  for (const [day, val] of Object.entries(openingHours)) {
    const d = plain(day);
    let i = DAYS_EN.findIndex(x => d.startsWith(x.slice(0, 3)));
    if (i < 0) i = DAYS_HE.findIndex(x => d === x || d === 'יום ' + x || d.endsWith(' ' + x));
    if (i < 0 && /שבת/u.test(d)) i = 6;
    if (i >= 0) week[i] = parseDayHours(Array.isArray(val) ? val.join(', ') : val);
  }
  return week;
}

function israelClock(now) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), min: Number(p.hour) % 24 * 60 + Number(p.minute) };
}
// In words, the way the phone voice says times ("שבע וחצי בערב"); midnight is "חצות".
export const spokenClock = min => {
  min = ((min % 1440) + 1440) % 1440;
  if (min === 0) return 'חצות';
  return spokenTime(String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0')).replace(' בדיוק', '');
};
const rangesText = r => r == null ? 'לא ידוע' : !r.length ? 'סגור' : r.map(([a, b]) => b - a >= 1440 ? '24 שעות' : 'מ' + spokenClock(a) + ' עד ' + spokenClock(b)).join(' ו');

/** Open now? { state: 'open'|'closed'|'unknown', until, opensDay, opensAt, today, tomorrow } */
export function openStateNow(week, now = new Date()) {
  const { day, min } = israelClock(now);
  const today = week[day], yesterday = week[(day + 6) % 7];
  if (today == null && yesterday == null) return { state: 'unknown' };
  // Last night's hours that run past midnight count first.
  for (const [a, b] of yesterday || []) if (b > 1440 && min < b - 1440) return { state: 'open', until: b - 1440, today: rangesText(today), tomorrow: rangesText(week[(day + 1) % 7]) };
  for (const [a, b] of today || []) if (min >= a && min < b) return { state: 'open', until: b, today: rangesText(today), tomorrow: rangesText(week[(day + 1) % 7]) };
  if (today == null) return { state: 'unknown' };
  // Closed: when it opens next (later today, or the next day it has hours).
  const later = (today || []).find(([a]) => a > min);
  if (later) return { state: 'closed', opensDay: 'היום', opensAt: later[0], today: rangesText(today), tomorrow: rangesText(week[(day + 1) % 7]) };
  for (let k = 1; k <= 7; k++) {
    const r = week[(day + k) % 7];
    if (r && r.length) return { state: 'closed', opensDay: k === 1 ? 'מחר' : 'ב' + SPOKEN_DAY[(day + k) % 7], opensAt: r[0][0], today: rangesText(today), tomorrow: rangesText(week[(day + 1) % 7]) };
  }
  return { state: 'closed', today: rangesText(today), tomorrow: rangesText(week[(day + 1) % 7]) };
}

/** Serper maps search: Google Maps listings, each with its opening hours when Google has them. */
export async function serperMaps(q, { keys = [], fetchImpl = fetch, timeoutMs = 5000, ll = '', log = console } = {}) {
  const query = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!query || !keys.length) return [];
  return cached('maps|' + query + '|' + ll, 6 * 3600 * 1000, async () => {
    for (const key of keys) {
      try {
        const r = await fetchImpl('https://google.serper.dev/maps', { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { 'X-API-KEY': key, 'content-type': 'application/json' }, body: JSON.stringify({ q: query, gl: 'il', hl: 'iw', ...(ll ? { ll } : {}) }) });
        if (!r.ok) { log.warn?.('[MAPS_HOURS] Serper maps answered', { status: r.status }); continue; }
        const j = await r.json().catch(() => null);
        const places = (j?.places || []).map(p => ({ title: String(p.title || ''), address: String(p.address || ''), phone: String(p.phoneNumber || ''), type: String(p.type || ''), lat: Number(p.latitude), lon: Number(p.longitude), website: String(p.website || ''), openingHours: p.openingHours || null })).filter(p => p.title);
        log.info?.('[MAPS_HOURS] Google map listings', { found: places.length, withHours: places.filter(p => p.openingHours).length });
        return places;
      } catch (e) { log.warn?.('[MAPS_HOURS] Serper maps failed', String(e?.message || e).slice(0, 80)); }
    }
    throw new Error('maps search unavailable');
  });
}

/**
 * The business he named, in the town (and mall / street) he named: its Google
 * listing with this minute's open state. Returns null when nothing fits for sure.
 */
export async function mapsBusinessHours({ name = '', place = '', town = '' } = {}, { keys = [], fetchImpl = fetch, log = console, now = new Date(), geo = null } = {}) {
  const bw = wordsOf(name);
  if (!bw.length || !keys.length) return null;
  const ll = geo && Number.isFinite(geo.lat) ? '@' + geo.lat.toFixed(4) + ',' + geo.lon.toFixed(4) + ',14z' : '';
  const q = [name, place, town].filter(Boolean).join(' ');
  let places = await serperMaps(q, { keys, fetchImpl, ll, log }).catch(() => []);
  if (!places.length && place) places = await serperMaps([name, town].filter(Boolean).join(' '), { keys, fetchImpl, ll, log }).catch(() => []);
  const tw = wordsOf(town), pw = wordsOf(place);
  const scored = places.map(p => {
    const hay = plain(p.title + ' ' + p.address);
    const nameOk = bw.every(w => has(plain(p.title), w) || has(hay, w));
    const townOk = !tw.length || tw.every(w => has(hay, w)) || (geo && Number.isFinite(p.lat) && Math.hypot(p.lat - geo.lat, (p.lon - geo.lon) * 0.85) < 0.06);
    const placeHits = pw.filter(w => has(hay, w)).length;
    return { p, ok: nameOk && townOk, score: placeHits * 2 + (p.openingHours ? 1 : 0) };
  }).filter(x => x.ok).sort((a, b) => b.score - a.score);
  // He named a mall or street: a listing that does not mention it is another
  // branch (live check: "Super-Pharm in the Zahav mall" got the Gallery branch).
  // One branch only in that town: that is the one he means.
  if (pw.length && scored.length > 1 && !(scored[0].score >= 2)) return { found: false, otherBranch: true, candidates: scored.slice(0, 3).map(x => x.p.title + ', ' + x.p.address) };
  if (!scored.length) return { found: false, candidates: places.slice(0, 3).map(p => p.title + ', ' + p.address) };
  const pick = { ...scored[0].p, address: cleanAddress(scored[0].p.address), phone: localPhone(scored[0].p.phone) }, week = parseWeek(pick.openingHours), st = openStateNow(week, now);
  const others = scored.slice(1, 3).map(x => x.p);
  const nowText = spokenClock(israelClock(now).min);
  const line = st.state === 'open' ? 'פתוח עכשיו (השעה ' + nowText + '), עד ' + spokenClock(st.until) + '.'
    : st.state === 'closed' ? 'סגור עכשיו (השעה ' + nowText + ')' + (st.opensAt != null ? ', נפתח ' + st.opensDay + ' ב' + spokenClock(st.opensAt) : '') + '.'
      : 'לא רשומות שעות פתיחה ליום הזה.';
  const text = 'לפי הרישום של העסק בגוגל מפות: ' + pick.title + (pick.address ? ', כתובת: ' + pick.address : '') + (pick.phone ? ', טלפון: ' + pick.phone : '') + '.\n' +
    line + (st.today ? ' שעות היום: ' + st.today + '.' : '') + (st.tomorrow ? ' שעות מחר: ' + st.tomorrow + '.' : '') +
    (others.length ? '\nעוד סניפים שנמצאו: ' + others.map(o => o.title + (o.address ? ' (' + o.address + ')' : '')).join('; ') + '.' : '') +
    '\nהשעות לפי גוגל; בחגים ובימים מיוחדים הן עשויות להשתנות.';
  return { found: true, place: pick, state: st, week, text, spoken: pick.title + ' ' + line };
}
