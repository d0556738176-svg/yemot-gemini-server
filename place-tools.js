// Place tools for extensions 1 and 3 (owner, 18.11.2026).
//
// From the calls of 18.11: "where is the nearest synagogue to the separate
// beach in Ashkelon" and "when is the end of the time of Shema (GRA) in moshav
// Otzem" got poor answers. Both came from web snippets and the model's memory:
//  * halachic times are a calculation (sun position at a place on a date), so
//    a web page about another city or another day gives a wrong time;
//  * "the nearest X to a place" is a map question; search snippets have no
//    distances and the model guessed.
// Now both are answered from real data:
//  * the place is found on the map (OpenStreetMap, free, no key), and checked
//    to be in the town he said (18.11 test: "החוף הנפרד אשקלון" first matched
//    the separate beach of ASHDOD);
//  * halachic times come from Hebcal (free, no key) for that exact point and
//    date, with a local astronomical calculation when Hebcal does not answer;
//  * places near a point come from OpenStreetMap (Overpass), sorted by real
//    walking-line distance, with their street address when the map has it.
// Everything external is injected (fetchImpl), so this file tests offline.

import { openState, openLine } from './opening-hours.js';
import { existsSync, readFileSync } from 'node:fs';

const UA = 'yemot-ai-phone/1.0 (owner phone line; contact via github d0556738176-svg)';
// 19.11 from the server: overpass-api.de "at capacity" (502), kumi answers GET
// in ~3 s but POST times out, mail.ru 504. So: GET, all at once, first wins.
const OVERPASS = ['https://overpass.kumi.systems/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

// ---------- text helpers ----------
const plain = s => String(s || '').replace(/[״"׳'`]/g, '').replace(/[-־–—_,.()]/g, ' ').replace(/\s+/g, ' ').trim();
// Same town under its usual spellings (קרית / קריית, with or without ה).
export function sameTown(a, b) {
  const f = s => plain(s).replace(/קריית/g, 'קרית').replace(/^ה/u, '').replace(/\s+/g, '');
  const x = f(a), y = f(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}
function km(a, b) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const distanceKm = km;
export function spokenDistance(k) {
  if (!(k >= 0)) return '';
  if (k < 0.95) { const m = Math.max(50, Math.round(k * 1000 / 50) * 50); return m + ' מטר'; }
  const v = Math.round(k * 10) / 10;
  return (Number.isInteger(v) ? String(v) : String(v).replace('.', ' נקודה ')) + ' קילומטר';
}

// ---------- spoken Hebrew times ----------
const UNITS_F = ['', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר', 'אחת עשרה', 'שתים עשרה', 'שלוש עשרה', 'ארבע עשרה', 'חמש עשרה', 'שש עשרה', 'שבע עשרה', 'שמונה עשרה', 'תשע עשרה'];
const TENS = { 2: 'עשרים', 3: 'שלושים', 4: 'ארבעים', 5: 'חמישים' };
function minutesWords(m) {
  if (m < 20) return UNITS_F[m];
  const t = Math.floor(m / 10), u = m % 10;
  return u ? TENS[t] + ' ו' + UNITS_F[u] : TENS[t];
}
// "08:49" -> "שמונה ארבעים ותשע בבוקר" (the phone voice garbles "8:49").
export function spokenTime(hhmm) {
  const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return String(hhmm || '');
  const h24 = Number(m[1]), min = Number(m[2]);
  const h = h24 % 12 || 12;
  const part = h24 < 4 ? 'לפנות בוקר' : h24 < 12 ? 'בבוקר' : h24 < 16 ? 'בצהריים' : h24 < 18 ? 'אחר הצהריים' : h24 < 22 ? 'בערב' : 'בלילה';
  const words = min === 0 ? UNITS_F[h] + ' בדיוק' : min === 15 ? UNITS_F[h] + ' ורבע' : min === 30 ? UNITS_F[h] + ' וחצי' : UNITS_F[h] + ' ו' + minutesWords(min) + (min === 1 ? ' דקה' : ' דקות');
  return words + ' ' + part;
}

// ---------- dates ----------
const DAY_NAMES = [['ראשון', 0], ['שני', 1], ['שלישי', 2], ['רביעי', 3], ['חמישי', 4], ['שישי', 5], ['שבת', 6]];
const HE_DAY = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
// Israel calendar date (YYYY-MM-DD) for "now".
export function israelDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekday(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }
export function spokenDate(iso, today) {
  if (iso === today) return 'היום';
  if (iso === addDays(today, 1)) return 'מחר';
  const d = new Date(iso + 'T12:00:00Z');
  return 'ביום ' + HE_DAY[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ב' + ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'][d.getUTCMonth()];
}
// The day he asks about, from his words (the planner's date wins when valid).
export function resolveDate(text, plannerDate = '', now = new Date()) {
  const today = israelDate(now);
  if (/^\d{4}-\d{2}-\d{2}$/.test(plannerDate)) {
    const diff = (Date.parse(plannerDate) - Date.parse(today)) / 86400000;
    if (diff >= -2 && diff <= 400) return plannerDate;
  }
  const t = String(text || '');
  if (/מחרתיים/u.test(t)) return addDays(today, 2);
  if (/(?:^|\s)מחר(?=$|[\s?.,!])/u.test(t)) return addDays(today, 1);
  if (/אתמול/u.test(t)) return addDays(today, -1);
  if (/(?:מוצאי שבת|מוצ״ש|מוצש|צאת השבת|יציאת השבת|הבדלה)/u.test(t)) { const w = weekday(today); return addDays(today, (6 - w + 7) % 7); }
  if (/(?:כניסת השבת|הדלקת נרות|ערב שבת|שישי)/u.test(t)) { const w = weekday(today); return addDays(today, (5 - w + 7) % 7); }
  for (const [name, idx] of DAY_NAMES) {
    if (new RegExp('(?:ביום|יום|ב)' + name + '(?=$|[\\s?.,!])', 'u').test(t)) { const w = weekday(today); return addDays(today, (idx - w + 7) % 7); }
  }
  return today;
}

// ---------- the local map (deploy/vps/osm-update.sh) ----------
// Israel's places from OpenStreetMap, on this server, in ~5 km squares.
const TILE_DIR = () => process.env.OSM_TILES || '/var/lib/yemot-data/osm/tiles';
const tileCache = new Map();
function localMapReady() { try { return existsSync(TILE_DIR()); } catch { return false; } }
function tileRows(key) {
  if (tileCache.has(key)) return tileCache.get(key);
  let rows = [];
  try { rows = readFileSync(TILE_DIR() + '/' + key + '.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
  tileCache.set(key, rows);
  if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value);
  return rows;
}
// Every place in the box [south, north, west, east].
function localPlaces(b) {
  const out = [];
  for (let la = Math.floor(b[0] * 20); la <= Math.floor(b[1] * 20); la++)
    for (let lo = Math.floor(b[2] * 20); lo <= Math.floor(b[3] * 20); lo++)
      for (const r of tileRows(la + '_' + lo)) if (r[0] >= b[0] && r[0] <= b[1] && r[1] >= b[2] && r[1] <= b[3]) out.push({ lat: r[0], lon: r[1], tags: { ...r[3], name: r[2] } });
  return out;
}
const boxAround = (loc, km) => { const d = km / 111, e = km / (111 * Math.cos(loc.lat * Math.PI / 180)); return [loc.lat - d, loc.lat + d, loc.lon - e, loc.lon + e]; };
export function clearTileCache() { tileCache.clear(); }

// ---------- geocoding ----------
async function getJson(url, { fetchImpl = fetch, timeoutMs = 6000, headers = {}, method = 'GET', body } = {}) {
  const r = await fetchImpl(url, { method, body, headers: { 'user-agent': UA, 'accept-language': 'he,en;q=0.7', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
  return r.json();
}
function townOf(addr = {}) { return addr.city || addr.town || addr.village || addr.municipality || addr.suburb || addr.hamlet || ''; }
// Answers are kept for a day: the same place costs nothing the second time,
// and the public map servers are asked as little as possible (their rules).
const cache = new Map();
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.p;
  const p = fn().catch(e => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), p });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return p;
}
export function clearPlaceCache() { cache.clear(); }
function nominatim(q, opts = {}) { return cached('n|' + q + '|' + (opts.limit || 6), () => nominatimRaw(q, opts)); }
async function nominatimRaw(q, { fetchImpl, timeoutMs = 6000, limit = 6 } = {}) {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', q); u.searchParams.set('countrycodes', 'il'); u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('accept-language', 'he'); u.searchParams.set('addressdetails', '1'); u.searchParams.set('limit', String(limit));
  const j = await getJson(u, { fetchImpl, timeoutMs });
  return (Array.isArray(j) ? j : []).map(x => ({ lat: Number(x.lat), lon: Number(x.lon), name: x.name || '', display: x.display_name || '', town: townOf(x.address), type: x.type || '', kind: x.category || x.class || '', bbox: (x.boundingbox || []).map(Number), importance: Number(x.importance) || 0 }))
    .filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lon));
}
async function openMeteoGeo(q, { fetchImpl, timeoutMs = 5000 } = {}) {
  const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
  u.searchParams.set('name', q); u.searchParams.set('count', '5'); u.searchParams.set('language', 'he'); u.searchParams.set('countryCode', 'IL');
  const j = await getJson(u, { fetchImpl, timeoutMs });
  return (j?.results || []).map(x => ({ lat: Number(x.latitude), lon: Number(x.longitude), name: x.name || '', display: [x.name, x.admin2, x.admin1].filter(Boolean).join(', '), town: x.name || '', type: 'town', kind: 'place', bbox: [] }));
}
// Overpass with several public servers; the first that answers wins.
export async function overpass(query, { fetchImpl = fetch, timeoutMs = 9000, servers = OVERPASS } = {}) {
  const tries = servers.map(s => getJson(s + '?data=' + encodeURIComponent(query), { fetchImpl, timeoutMs })
    .then(j => { if (!Array.isArray(j?.elements)) throw new Error('bad overpass answer'); return j.elements; }));
  return Promise.any(tries);
}
// When every Overpass server is busy: the map's own search by name around the
// point ("בית כנסת" near the beach), from Nominatim.
async function nominatimNear(words, loc, radiusKm, { fetchImpl }) {
  const d = radiusKm / 111;
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', words); u.searchParams.set('format', 'jsonv2'); u.searchParams.set('accept-language', 'he'); u.searchParams.set('addressdetails', '1');
  u.searchParams.set('limit', '15'); u.searchParams.set('bounded', '1'); u.searchParams.set('countrycodes', 'il');
  u.searchParams.set('viewbox', [loc.lon - d, loc.lat + d, loc.lon + d, loc.lat - d].join(','));
  const j = await getJson(u, { fetchImpl, timeoutMs: 7000 });
  return (Array.isArray(j) ? j : []).map(x => ({ lat: Number(x.lat), lon: Number(x.lon), tags: { ...((x.category || x.class) ? { [x.category || x.class]: x.type || '' } : {}), name: x.name || '', 'addr:street': x.address?.road || '', 'addr:housenumber': x.address?.house_number || '', 'addr:city': townOf(x.address) } }));
}
const NEIGHBOURHOODS = [
  [/^(?:ב)?רמה\s*([אבגד])['׳]?$/u, 'רמת בית שמש $1', 'בית שמש'],
  [/^(?:ב)?רמב["״']?ש\s*([אבגד])['׳]?$/u, 'רמת בית שמש $1', 'בית שמש'],
  [/^(?:ב)?רמת בית שמש\s*([אבגד])['׳]?$/u, 'רמת בית שמש $1', 'בית שמש'],
  [/^(?:ב)?(?:שכונת\s+)?נופי? השמש$/u, 'נופי השמש', 'בית שמש'],
  [/^(?:ב)?(?:שכונת\s+)?רמות$/u, 'רמות', 'ירושלים']
];
const GENERIC = new Set(['חוף', 'החוף', 'רחוב', 'שכונת', 'שכונה', 'אזור', 'ליד', 'של', 'את', 'בית', 'מרכז', 'כיכר', 'גן', 'פארק', 'הים', 'ים']);
// The place he named, on the map: { lat, lon, label, approx }.
// town: the town he said (results elsewhere are rejected).
export async function geocode({ place = '', town = '' } = {}, { fetchImpl = fetch, log = console } = {}) {
  const strip = s => String(s || '').replace(/^(?:ב|ל)?(?:ה)?(?:מושב|משוב|קיבוץ|יישוב|ישוב|עיר|העיר|שכונת|ליד|באזור)\s+/u, '').trim();
  place = strip(place); town = strip(town);
  let alias = false;
  // Neighbourhoods said the way people say them ("רמה א" = רמת בית שמש א').
  for (const [rx, to, city] of NEIGHBOURHOODS) {
    const m = place.match(rx);
    if (m && (!town || sameTown(town, city))) { place = to.replace('$1', m[1] || ''); town = city; alias = true; break; }
  }
  if (place && town && !alias && sameTown(place, town)) place = '';
  if (!place && !town) return null;
  const inTown = r => !town || sameTown(r.town, town) || sameTown(r.display.split(',')[1] || '', town) || r.display.split(',').some(p => sameTown(p, town) && !/נפת|מחוז|מועצה/u.test(p));
  const full = [place, town].filter(Boolean).join(' ');
  let found = await nominatim(full, { fetchImpl }).catch(() => []);
  let hit = found.find(r => inTown(r) && (!place || !town || !sameTown(r.name, town) || sameTown(place, town)));
  if (hit) return { lat: hit.lat, lon: hit.lon, label: hit.name || full, town: hit.town || town, approx: false };
  // The town itself, then the landmark inside it by its distinctive words
  // ("נפרד" of "החוף הנפרד"), searched only within that town.
  let townHit = null;
  if (town) {
    const t = await nominatim(town, { fetchImpl, limit: 3 }).catch(() => []);
    townHit = t.find(r => sameTown(r.name, town) || sameTown(r.town, town)) || t[0] || null;
    if (!townHit) townHit = (await openMeteoGeo(town, { fetchImpl }).catch(() => []))[0] || null;
  }
  // A neighbourhood by its full name on the local map ("רמת בית שמש א'").
  if (alias && townHit && localMapReady()) {
    const want = plain(place);
    const b = [townHit.lat - 0.08, townHit.lat + 0.08, townHit.lon - 0.08, townHit.lon + 0.08];
    const LETTER = { 'א': 'אלף', 'ב': 'בית', 'ג': 'גימל', 'ד': 'דלת' };
    const names = new Set([want, want.replace(/ ([אבגד])$/u, (m, l) => ' ' + LETTER[l])]);
    const hits = localPlaces(b).filter(x => names.has(plain(x.tags.name || '')));
    const pick = hits.find(x => x.tags.place) || hits[0];
    if (pick) return { lat: pick.lat, lon: pick.lon, label: place, town, approx: false };
  }
  if (place && townHit && (alias || !sameTown(place, town))) {
    const words = plain(place).split(' ').filter(w => w.length >= 2 && !GENERIC.has(w)).map(w => w.replace(/^ה(?=\S{2})/u, ''));
    if (words.length) {
      const b = townHit.bbox?.length === 4 && Math.abs(townHit.bbox[1] - townHit.bbox[0]) > 0.01 ? townHit.bbox : [townHit.lat - 0.06, townHit.lat + 0.06, townHit.lon - 0.06, townHit.lon + 0.06];
      const rx = words.map(w => w.replace(/[^֐-׿a-zA-Z0-9]/g, '')).filter(Boolean).join('|');
      const q = `[out:json][timeout:12];nwr["name"~"${rx}"](${b[0]},${b[2]},${b[1]},${b[3]});out center tags 30;`;
      let els = localMapReady() ? localPlaces(b).filter(x => new RegExp(rx, 'u').test(x.tags.name || '')) : null;
      if (els && !els.length) els = null;
      if (els === null) els = await overpass(q, { fetchImpl, timeoutMs: 6000 }).catch(e => { log.warn?.('[PLACE] landmark search failed', String(e?.message || e).slice(0, 80)); return null; });
      if (els === null) els = await nominatimNear(plain(place), townHit, 8, { fetchImpl }).catch(() => []);
      const scored = els.map(e => ({ e, name: e.tags?.name || e.tags?.['name:he'] || '', lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon }))
        .filter(x => Number.isFinite(x.lat) && x.name)
        .map(x => ({ ...x, score: words.filter(w => plain(x.name).includes(w)).length + (/beach|natural/.test(JSON.stringify(x.e.tags)) && /חוף/u.test(place) ? 1 : 0) }))
        .sort((a, b) => b.score - a.score);
      if (scored[0]) return { lat: scored[0].lat, lon: scored[0].lon, label: scored[0].name, town, approx: false };
    }
  }
  if (!town && place) {
    found = found.length ? found : await openMeteoGeo(place, { fetchImpl }).catch(() => []);
    if (found[0]) return { lat: found[0].lat, lon: found[0].lon, label: found[0].name || place, town: found[0].town || '', approx: false };
  }
  if (townHit) return { lat: townHit.lat, lon: townHit.lon, label: town, town, approx: !!place && !sameTown(place, town) };
  return null;
}

// ---------- halachic times ----------
const ZMAN_ORDER = [
  ['alotHaShachar', 'עלות השחר (72 דקות זמניות לפני הנץ, 16.1 מעלות)'],
  ['misheyakir', 'משיכיר, זמן ציצית ותפילין (11.5 מעלות)'],
  ['sunrise', 'הנץ החמה (זריחה במישור)'],
  ['sofZmanShmaMGA', 'סוף זמן קריאת שמע לפי המגן אברהם (72 דקות)'],
  ['sofZmanShma', 'סוף זמן קריאת שמע לפי הגר״א'],
  ['sofZmanTfillaMGA', 'סוף זמן תפילה לפי המגן אברהם'],
  ['sofZmanTfilla', 'סוף זמן תפילה לפי הגר״א'],
  ['chatzot', 'חצות היום'],
  ['minchaGedola', 'מנחה גדולה'],
  ['minchaKetana', 'מנחה קטנה'],
  ['plagHaMincha', 'פלג המנחה'],
  ['sunset', 'שקיעה'],
  ['tzeit7083deg', 'צאת הכוכבים (7.083 מעלות, כ־20 דקות אחרי השקיעה)'],
  ['tzeit85deg', 'צאת הכוכבים 8.5 מעלות (מקובל לצאת שבת)'],
  ['tzeit72min', 'צאת הכוכבים לרבנו תם (72 דקות)'],
  ['chatzotNight', 'חצות הלילה']
];
const hhmm = iso => { const m = String(iso || '').match(/T(\d{2}):(\d{2})/); return m ? m[1] + ':' + m[2] : ''; };
function hebcalZmanim(lat, lon, date, opts = {}) { return cached('h|' + lat.toFixed(3) + '|' + lon.toFixed(3) + '|' + date, () => hebcalRaw(lat, lon, date, opts)); }
async function hebcalRaw(lat, lon, date, { fetchImpl, timeoutMs = 6000 } = {}) {
  const u = new URL('https://www.hebcal.com/zmanim');
  u.searchParams.set('cfg', 'json'); u.searchParams.set('latitude', lat.toFixed(4)); u.searchParams.set('longitude', lon.toFixed(4));
  u.searchParams.set('tzid', 'Asia/Jerusalem'); u.searchParams.set('date', date);
  const j = await getJson(u, { fetchImpl, timeoutMs });
  if (!j?.times?.sunrise) throw new Error('no times');
  const out = {}; for (const [k, v] of Object.entries(j.times)) { const t = hhmm(v); if (t) out[k] = t; }
  return out;
}
// Local calculation (NOAA sun position), used only when Hebcal is unreachable.
function sunTime(date, lat, lon, zenith, rising) {
  const d = new Date(date + 'T00:00:00Z');
  const N = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
  const rad = Math.PI / 180, lngHour = lon / 15;
  const t = N + ((rising ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  let L = (M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634) % 360; if (L < 0) L += 360;
  let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad; RA = (RA + 360) % 360;
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(zenith * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return null;
  const H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  return ((T - lngHour) % 24 + 24) % 24; // UTC hours
}
function israelOffsetHours(date) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' });
  return (Number(f.format(new Date(date + 'T12:00:00Z'))) - 12 + 24) % 24;
}
export function localZmanim(lat, lon, date) {
  const off = israelOffsetHours(date);
  const sr = sunTime(date, lat, lon, 90.833, true), ss = sunTime(date, lat, lon, 90.833, false);
  if (sr == null || ss == null) return null;
  const toLocal = h => { const x = ((h + off) % 24 + 24) % 24; const tot = Math.round(x * 60); return String(Math.floor(tot / 60) % 24).padStart(2, '0') + ':' + String(tot % 60).padStart(2, '0'); };
  const day = ss - sr, hr = day / 12, mga0 = sr - 1.2, mgaHr = (day + 2.4) / 12;
  const a161 = sunTime(date, lat, lon, 106.1, true), t85 = sunTime(date, lat, lon, 98.5, false), t7 = sunTime(date, lat, lon, 97.083, false), my = sunTime(date, lat, lon, 101.5, true);
  return {
    ...(a161 != null ? { alotHaShachar: toLocal(a161) } : {}), ...(my != null ? { misheyakir: toLocal(my) } : {}),
    sunrise: toLocal(sr), sofZmanShmaMGA: toLocal(mga0 + 3 * mgaHr), sofZmanShma: toLocal(sr + 3 * hr),
    sofZmanTfillaMGA: toLocal(mga0 + 4 * mgaHr), sofZmanTfilla: toLocal(sr + 4 * hr), chatzot: toLocal(sr + 6 * hr),
    minchaGedola: toLocal(sr + 6.5 * hr), minchaKetana: toLocal(sr + 9.5 * hr), plagHaMincha: toLocal(sr + 10.75 * hr), sunset: toLocal(ss),
    ...(t7 != null ? { tzeit7083deg: toLocal(t7) } : {}), ...(t85 != null ? { tzeit85deg: toLocal(t85) } : {}), tzeit72min: toLocal(ss + 1.2)
  };
}
// Words that mean he is asking for a halachic time of day.
export const ZMANIM_WORDS = /(?:קריאת שמע|ק״ש|קש של|זמן ק\s*ש|סוף זמן|זמן תפילה|סוף זמן תפילה|הנץ|נץ החמה|זריחה|שקיעה|עלות השחר|עלות|צאת הכוכבים|צאת השבת|יציאת השבת|כניסת השבת|הדלקת נרות|זמן הדלקה|הבדלה|מוצאי שבת|חצות|מנחה גדולה|מנחה קטנה|פלג המנחה|זמני היום|זמני תפילה|זמן ציצית|משיכיר|בין השמשות|רבנו תם|רבינו תם|תחילת הצום|סוף הצום|צאת הצום|זמנים הלכתיים|זמני הלכה|לפי הגרא|לפי הגר״א|מגן אברהם|המג״א)/u;
// "What is alot hashachar?" asks for an explanation, not for today's time.
const EXPLAIN = /(?:מה זה|מה פירוש|מה הפירוש|מה המשמעות|למה|מדוע|מה ההבדל|תסביר|תסבירי|הסבר|מה המקור|מאיפה|מי קבע|איך מחשבים|איך יודעים)/u;
export function isZmanimQuestion(text) { const t = String(text || ''); return ZMANIM_WORDS.test(t) && !(EXPLAIN.test(t) && !/(?:מתי|באיזו שעה|באיזה שעה|עד מתי|היום|מחר)/u.test(t)); }

// All the day's times for a place, as text for the answer model and the
// spoken times ready for the phone. Returns null when the place is unknown.
export async function zmanimFacts({ place = '', town = '', date = '', utterance = '' } = {}, { fetchImpl = fetch, log = console, now = new Date() } = {}) {
  const today = israelDate(now);
  const day = resolveDate(utterance, date, now);
  const asked = place || town;
  const loc = asked ? await geocode({ place, town }, { fetchImpl, log }).catch(() => null) : { lat: 31.7780, lon: 35.2354, label: 'ירושלים', town: 'ירושלים', approx: false, assumed: true };
  if (!loc) return { unknownPlace: asked };
  let times = null, source = 'hebcal';
  try { times = await hebcalZmanim(loc.lat, loc.lon, day, { fetchImpl }); }
  catch (e) { log.warn?.('[ZMANIM] Hebcal unavailable; local calculation', String(e?.message || e).slice(0, 80)); times = localZmanim(loc.lat, loc.lon, day); source = 'local'; }
  if (!times) return null;
  const w = weekday(day);
  const extra = [];
  if (w === 5 && times.sunset) {
    const [h, m] = times.sunset.split(':').map(Number);
    const jlm = sameTown(loc.town || loc.label, 'ירושלים');
    const minus = jlm ? 40 : 20;
    const t = h * 60 + m - minus;
    extra.push('הדלקת נרות שבת (' + minus + ' דקות לפני השקיעה' + (jlm ? ', מנהג ירושלים' : ', יש מקומות שנוהגים 30 או 40') + '): ' + spokenTime(String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0')));
  }
  const lines = ZMAN_ORDER.filter(([k]) => times[k]).map(([k, label]) => label + ': ' + spokenTime(times[k]) + ' (' + times[k] + ')');
  const where = loc.label + (loc.town && !sameTown(loc.label, loc.town) ? ', ' + loc.town : '');
  const text = 'זמני היום ההלכתיים, מחושבים עכשיו לפי מיקום ' + where + (loc.approx ? ' (לא מצאתי את המקום המדויק, החישוב לפי מרכז ' + loc.town + ')' : '') + (loc.assumed ? ' (לא נאמר מקום, החישוב לפי ירושלים)' : '') +
    ', ל' + spokenDate(day, today).replace(/^ב?/u, '') + ' (' + day + '), בשעון ישראל' + (source === 'local' ? ', בחישוב אסטרונומי מקומי' : ' (לוח Hebcal)') + ':\n' + [...lines, ...extra].join('\n');
  return { loc, date: day, times, text, source, when: spokenDate(day, today) };
}

// ---------- places near a point ----------
// Hebrew kind of place -> OpenStreetMap filters.
const KINDS = [
  [/בית כנסת|בתי כנסת|בית הכנסת|מניין|מנין|מקום תפילה|להתפלל|שטיבל/u, 'בית כנסת', ['["amenity"="place_of_worship"]["religion"="jewish"]', '["name"~"בית כנסת|בית הכנסת|בית מדרש|בהכנ|synagogue",i]'], (t, n) => (t.amenity === 'place_of_worship' && t.religion === 'jewish') || /בית ה?כנסת|בית ה?מדרש|synagogue/i.test(n)],
  [/מקווה|מקוה/u, 'מקווה', ['["amenity"="mikveh"]', '["name"~"מקווה|מקוה|mikve",i]'], (t, n) => t.amenity === 'mikveh' || /מקו?וה|mikve/i.test(n)],
  [/בית מרקחת|בתי מרקחת|פארם|תרופות/u, 'בית מרקחת', ['["amenity"="pharmacy"]'], t => t.amenity === 'pharmacy'],
  [/סופר|מכולת|מרכול|סופרמרקט|מינימרקט|קניות/u, 'סופר או מכולת', ['["shop"~"^(supermarket|convenience|grocery)$"]'], t => /^(supermarket|convenience|grocery)$/.test(t.shop || '')],
  [/מסעד|אוכל|פיצ|פלאפל|שווארמה|המבורגר|בית קפה|קפה/u, 'מסעדה או בית קפה', ['["amenity"~"^(restaurant|fast_food|cafe)$"]'], t => /^(restaurant|fast_food|cafe)$/.test(t.amenity || '')],
  [/כספומט|בנק/u, 'כספומט או בנק', ['["amenity"~"^(atm|bank)$"]'], t => /^(atm|bank)$/.test(t.amenity || '')],
  [/תחנת דלק|דלק|סונול|פז|דור אלון/u, 'תחנת דלק', ['["amenity"="fuel"]'], t => t.amenity === 'fuel'],
  [/בית חולים|מיון/u, 'בית חולים', ['["amenity"="hospital"]'], t => t.amenity === 'hospital'],
  [/קופת חולים|מרפאה|רופא|כללית|מכבי|מאוחדת|לאומית/u, 'מרפאה', ['["amenity"~"^(clinic|doctors)$"]'], t => /^(clinic|doctors)$/.test(t.amenity || '')],
  [/דואר/u, 'סניף דואר', ['["amenity"="post_office"]'], t => t.amenity === 'post_office'],
  [/תחנת אוטובוס|אוטובוס|תחנה/u, 'תחנת אוטובוס', ['["highway"="bus_stop"]'], t => t.highway === 'bus_stop'],
  [/רכבת/u, 'תחנת רכבת', ['["railway"="station"]'], t => t.railway === 'station'],
  [/חניה|חניון|חנייה/u, 'חניון', ['["amenity"="parking"]'], t => t.amenity === 'parking'],
  [/שירותים|נוחיות/u, 'שירותים ציבוריים', ['["amenity"="toilets"]'], t => t.amenity === 'toilets'],
  [/מלון|צימר|לינה|אכסניה/u, 'מקום לינה', ['["tourism"~"^(hotel|guest_house|hostel|motel|chalet)$"]'], t => /^(hotel|guest_house|hostel|motel|chalet)$/.test(t.tourism || '')],
  [/גן שעשועים|מגלשות|נדנדות/u, 'גן שעשועים', ['["leisure"="playground"]'], t => t.leisure === 'playground'],
  [/פארק|גינה/u, 'פארק או גינה', ['["leisure"~"^(park|garden)$"]'], t => /^(park|garden)$/.test(t.leisure || '')],
  [/חוף/u, 'חוף רחצה', ['["natural"="beach"]'], t => t.natural === 'beach'],
  [/משטרה/u, 'תחנת משטרה', ['["amenity"="police"]'], t => t.amenity === 'police'],
  [/ספרייה|ספריה/u, 'ספרייה', ['["amenity"="library"]'], t => t.amenity === 'library'],
  [/מאפייה|מאפיה|לחם/u, 'מאפייה', ['["shop"="bakery"]'], t => t.shop === 'bakery'],
  [/קניון|מרכז מסחרי/u, 'קניון', ['["shop"="mall"]'], t => t.shop === 'mall'],
  [/ישיבה|כולל|בית מדרש/u, 'ישיבה או בית מדרש', ['["name"~"ישיבה|ישיבת|כולל|בית מדרש|בית המדרש"]'], (t, n) => /ישיבה|ישיבת|כולל|בית ה?מדרש/.test(n)],
  [/מים|ברזיה|מי שתייה/u, 'ברזיית מים', ['["amenity"="drinking_water"]'], t => t.amenity === 'drinking_water'],
  [/טעינה|עמדת טעינה/u, 'עמדת טעינה', ['["amenity"="charging_station"]'], t => t.amenity === 'charging_station'],
  [/חנות ספרים|חנויות ספרים|ספרי קודש|ספרים|סטימצקי|צומת ספרים/u, 'חנות ספרים', ['["shop"="books"]', '["name"~"ספרים|ספרי|סטימצקי|צומת ספרים"]'], (t, n) => t.shop === 'books' || /ספרים|ספרי קודש|סטימצקי|צומת ספרים/.test(n)],
  [/מספרה|תספורת|ספר שיער|ספרית/u, 'מספרה', ['["shop"="hairdresser"]'], t => t.shop === 'hairdresser'],
  [/חשמל|מוצרי חשמל|מכונות/u, 'חנות מוצרי חשמל', ['["shop"~"^(electronics|appliance|hardware)$"]'], t => /^(electronics|appliance|hardware)$/.test(t.shop || '')],
  [/בגדים|ביגוד|נעליים/u, 'חנות בגדים או נעליים', ['["shop"~"^(clothes|shoes)$"]'], t => /^(clothes|shoes)$/.test(t.shop || '')],
  [/ירקות|פירות|ירקן/u, 'ירקן', ['["shop"="greengrocer"]'], t => t.shop === 'greengrocer'],
  [/אטליז|קצב/u, 'אטליז', ['["shop"="butcher"]'], t => t.shop === 'butcher'],
  [/מכון כושר|חדר כושר/u, 'מכון כושר', ['["leisure"="fitness_centre"]'], t => t.leisure === 'fitness_centre']
];
export function nearbyKind(text) { for (const [rx, label, filters, test] of KINDS) if (rx.test(String(text || ''))) return { label, filters, test }; return null; }
export const NEARBY_WORDS = /(?:הכי קרוב|הקרוב ביותר|הקרובה ביותר|הכי קרובה|הקרובים|הקרובות|קרוב ל|קרובה ל|ליד ה?|בסביבת|בסביבה|באזור של|בקרבת|מסביב ל|במרחק הליכה|איפה יש|איפה נמצא|איפה נמצאת|איפה אפשר למצוא)/u;
export function isNearbyQuestion(text) { const t = String(text || ''); return NEARBY_WORDS.test(t) && !!nearbyKind(t); }

function addressOf(tags = {}) {
  const street = tags['addr:street:he'] || tags['addr:street'] || '';
  const num = tags['addr:housenumber'] || '';
  const city = tags['addr:city:he'] || tags['addr:city'] || '';
  return [street && num ? street + ' ' + num : street, city].filter(Boolean).join(', ');
}
async function reverseAddress(lat, lon, { fetchImpl }) {
  const u = new URL('https://nominatim.openstreetmap.org/reverse');
  u.searchParams.set('lat', String(lat)); u.searchParams.set('lon', String(lon)); u.searchParams.set('format', 'jsonv2'); u.searchParams.set('accept-language', 'he'); u.searchParams.set('zoom', '18');
  const j = await getJson(u, { fetchImpl, timeoutMs: 4000 });
  const a = j?.address || {};
  const street = a.road || a.pedestrian || a.footway || '';
  return [street && a.house_number ? street + ' ' + a.house_number : street, townOf(a)].filter(Boolean).join(', ');
}
// The nearest places of a kind to the point he named, nearest first.
export const OPEN_NOW = /(?:פתוח|פתוחה|פתוחים|פתוחות|תורנ|עובד עכשיו|עובדת עכשיו)/u;
export async function nearbyFacts({ kindText = '', place = '', town = '', openNow = false } = {}, { fetchImpl = fetch, log = console, now = new Date() } = {}) {
  openNow = openNow || OPEN_NOW.test(kindText);
  const kind = nearbyKind(kindText);
  if (!kind) return null;
  const loc = await geocode({ place, town }, { fetchImpl, log }).catch(() => null);
  if (!loc) return { unknownPlace: place || town, kind: kind.label };
  let items = [];
  for (const radius of [3000, 12000]) {
    const q = '[out:json][timeout:15];(' + kind.filters.map(f => `nwr${f}(around:${radius},${loc.lat},${loc.lon});`).join('') + ');out center tags 60;';
    let els = localMapReady() ? localPlaces(boxAround(loc, radius / 1000)).filter(x => kind.test(x.tags, x.tags.name || '') && km(loc, x) <= radius / 1000) : null;
    if (els === null) els = await overpass(q, { fetchImpl, timeoutMs: 7000 }).catch(e => { log.warn?.('[PLACE] nearby search failed', String(e?.message || e).slice(0, 80)); return null; });
    if (els === null) {
      els = await nominatimNear(kind.label.split(' או ')[0], loc, radius / 1000, { fetchImpl }).then(r => r.filter(x => kind.test(x.tags, x.tags.name || ''))).catch(() => null);
      if (els === null) return { loc, kind: kind.label, mapDown: true, items: [] };
      log.info?.('[PLACE] nearby from the map search by name', { found: els.length });
    }
    const seen = new Set();
    items = els.map(e => ({ tags: e.tags || {}, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon }))
      .filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lon))
      .map(x => ({ name: x.tags['name:he'] || x.tags.name || '', address: addressOf(x.tags), km: km(loc, x), lat: x.lat, lon: x.lon, phone: x.tags.phone || x.tags['contact:phone'] || '', hours: x.tags.opening_hours || '', denomination: x.tags.denomination || '' }))
      .filter(x => { const k = (x.name || '') + '|' + Math.round(x.lat * 2000) + '|' + Math.round(x.lon * 2000); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.km - b.km)
      .map(x => ({ ...x, open: x.hours ? openState(x.hours, now) : { state: 'unknown' } }));
    // "Open now": the open ones first (by distance), the ones known to be
    // closed are left out when there are open ones, unknown hours stay last.
    if (openNow) {
      const rank = x => x.open.state === 'open' ? 0 : x.open.state === 'unknown' ? 1 : 2;
      const anyOpen = items.some(x => x.open.state === 'open');
      items = items.filter(x => !anyOpen || x.open.state !== 'closed').sort((a, b) => rank(a) - rank(b) || a.km - b.km);
    }
    items = items.slice(0, 5);
    if (items.length && (!openNow || items.some(x => x.open.state === 'open') || radius === 12000)) break;
  }
  // Street address for the nearest ones the map lists without one.
  for (const x of items.slice(0, 2)) if (!x.address) x.address = await reverseAddress(x.lat, x.lon, { fetchImpl }).catch(() => '');
  const where = loc.label + (loc.town && !sameTown(loc.label, loc.town) ? ' ב' + loc.town : '');
  const text = 'מהמפה הפתוחה (OpenStreetMap), ' + kind.label + ' הקרובים ביותר ל' + where + (loc.approx ? ' (את המקום המדויק לא מצאתי במפה, המרחקים ממרכז ' + loc.town + ')' : '') + ', מהקרוב לרחוק, מרחק בקו אווירי:\n' +
    (items.length ? items.map((x, i) => (i + 1) + '. ' + (x.name || kind.label + ' בלי שם במפה') + (x.denomination ? ' (' + x.denomination + ')' : '') + ' - ' + spokenDistance(x.km) + (x.address ? ', כתובת: ' + x.address : '') + (x.phone ? ', טלפון: ' + x.phone : '') + (x.open.state !== 'unknown' ? ', ' + openLine(x.hours, now, spokenTime) + (x.open.today ? ' (' + x.open.today + ')' : '') : x.hours ? ', שעות לפי המפה: ' + x.hours : ', שעות הפתיחה לא מופיעות במפה')).join('\n') : 'לא נמצא אף ' + kind.label + ' במפה בטווח של 12 קילומטר.');
  const openNote = openNow ? '\nהוא שאל מה פתוח עכשיו. השעה עכשיו בישראל: ' + spokenTime(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)) + '. ' + (items.some(x => x.open.state === 'open') ? 'הפתוחים עכשיו לפי שעות המפה מופיעים ראשונים.' : 'במפה לא מצאתי מקום שמסומן כפתוח עכשיו; למקומות בלי שעות במפה צריך לברר בטלפון.') : '';
  return { loc, kind: kind.label, items, text: text + openNote, openNow };
}

// ---------- a named business: its hours on the map (owner, 19.11) ----------
// "Is Rami Levy in the Hasdera mall in Beit Shemesh open now?": the map's own
// entry for that business in that town, nearest to the place he said, with
// its hours worked out for this minute. Nothing found = nothing said.
export async function businessHours({ name = '', place = '', town = '' } = {}, { fetchImpl = fetch, log = console, now = new Date() } = {}) {
  const words = plain(name).split(' ').filter(w => w.length >= 2 && !GENERIC.has(w) && !/^(?:סניף|חנות|הסניף|החנות|פתוח|פתוחה|עכשיו)$/u.test(w));
  if (!words.length || !localMapReady()) return null;
  const loc = await geocode({ place, town }, { fetchImpl, log }).catch(() => null)
    || (town ? await geocode({ town }, { fetchImpl, log }).catch(() => null) : null);
  if (!loc) return null;
  const rows = localPlaces(boxAround(loc, place ? 4 : 8));
  const hits = rows.map(x => ({ x, n: plain(x.tags.name || '') }))
    .filter(({ n }) => n && words.every(w => n.includes(w) || n.includes(w.replace(/^ה/u, ''))))
    .map(({ x }) => ({ name: x.tags.name, address: addressOf(x.tags), phone: x.tags.phone || x.tags['contact:phone'] || '', hours: x.tags.opening_hours || '', km: km(loc, x) }))
    .sort((a, b) => a.km - b.km).slice(0, 3);
  if (!hits.length) return { loc, items: [], text: '' };
  const text = 'מהמפה הפתוחה (OpenStreetMap), ' + name + ' ליד ' + loc.label + (loc.town && !sameTown(loc.label, loc.town) ? ' ב' + loc.town : '') + ':\n' + hits.map((h, i) => {
    const s = h.hours ? openState(h.hours, now) : { state: 'unknown' };
    return (i + 1) + '. ' + h.name + ' - ' + spokenDistance(h.km) + ' מהמקום' + (h.address ? ', כתובת: ' + h.address : '') + (h.phone ? ', טלפון: ' + h.phone : '') +
      (s.state !== 'unknown' ? ', לפי שעות המפה: ' + openLine(h.hours, now, spokenTime) + (s.today ? ' (' + s.today + ')' : '') : h.hours ? ', שעות במפה: ' + h.hours : ', שעות הפתיחה לא מופיעות במפה');
  }).join('\n');
  return { loc, items: hits, text };
}
