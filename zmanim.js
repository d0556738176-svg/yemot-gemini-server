// Branch 1: answer halachic time (zmanim) questions from a real astronomical
// source (Hebcal's free zmanim API) instead of letting the language model
// invent times. Observed live: "סוף זמן קריאת שמע בבית שמש" was answered as a
// hallucinated 17:15 (an afternoon time for a morning zman). This module is
// deterministic and testable; the HTTP call is injectable.
//
// It reports the calculated times with their shita labels (גר"א / מג"א); it
// does not pasken — for halacha l'maaseh the caller follows their rav/minhag.

// Common Israeli locations (lat, lng). Default is Beit Shemesh (the system
// owner's city). Candle-lighting custom minutes before sunset per city.
const CITIES = [
  { re: /(בית שמש|רמת בית שמש|רב"ש)/i, name: 'בית שמש', lat: 31.7497, lng: 34.9876, candles: 20 },
  { re: /(ירושלים|עיר העתיקה|ירושילים)/i, name: 'ירושלים', lat: 31.7781, lng: 35.2353, candles: 40 },
  { re: /(בני ברק|ב"ב)/i, name: 'בני ברק', lat: 32.0807, lng: 34.8338, candles: 22 },
  { re: /(תל אביב|ת"א|גבעתיים|רמת גן)/i, name: 'תל אביב', lat: 32.0853, lng: 34.7818, candles: 22 },
  { re: /(חיפה|קריות|קרית)/i, name: 'חיפה', lat: 32.7940, lng: 34.9896, candles: 30 },
  { re: /(באר שבע|ב"ש)/i, name: 'באר שבע', lat: 31.2518, lng: 34.7913, candles: 22 },
  { re: /(אשדוד)/i, name: 'אשדוד', lat: 31.8040, lng: 34.6550, candles: 20 },
  { re: /(אשקלון)/i, name: 'אשקלון', lat: 31.6688, lng: 34.5742, candles: 20 },
  { re: /(נתניה)/i, name: 'נתניה', lat: 32.3215, lng: 34.8532, candles: 22 },
  { re: /(פתח תקווה|פתח תקוה)/i, name: 'פתח תקווה', lat: 32.0840, lng: 34.8878, candles: 22 },
  { re: /(מודיעין|מודיעין עילית|קרית ספר)/i, name: 'מודיעין', lat: 31.8928, lng: 35.0104, candles: 20 },
  { re: /(רחובות)/i, name: 'רחובות', lat: 31.8928, lng: 34.8113, candles: 20 },
  { re: /(אלעד)/i, name: 'אלעד', lat: 32.0520, lng: 34.9510, candles: 22 },
  { re: /(ביתר|ביתר עילית)/i, name: 'ביתר עילית', lat: 31.6960, lng: 35.1180, candles: 30 },
  { re: /(צפת)/i, name: 'צפת', lat: 32.9646, lng: 35.4960, candles: 30 },
  { re: /(טבריה)/i, name: 'טבריה', lat: 32.7922, lng: 35.5312, candles: 30 },
];
const DEFAULT_CITY = CITIES[0];
const TZID = 'Asia/Jerusalem';

// Each zman the caller may ask for, mapped to the Hebcal `times` field(s) and a
// spoken Hebrew label. The GRA time is primary; the מג"א variant is added when
// the caller asks about it or about kriat shema / tfilla (where it matters).
const ZMANIM = [
  { re: /(עלות השחר|עלות|עמוד השחר)/i, label: 'עלות השחר', field: 'alotHaShachar' },
  { re: /(משיכיר|זמן ציצית|זמן תפילין)/i, label: 'זמן ציצית ותפילין (משיכיר)', field: 'misheyakir' },
  { re: /(הנץ|נץ החמה|זריחה|נבג החמה)/i, label: 'הנץ החמה', field: 'sunrise' },
  { re: /(סוף זמן קריאת שמע|זמן קריאת שמע|קריאת שמע|ק"ש|קר"ש|סוף זמן שמע)/i, label: 'סוף זמן קריאת שמע', field: 'sofZmanShma', mga: 'sofZmanShmaMGA' },
  { re: /(סוף זמן תפילה|זמן תפילה|תפילת שחרית עד מתי)/i, label: 'סוף זמן תפילה', field: 'sofZmanTfilla', mga: 'sofZmanTfillaMGA' },
  { re: /(חצות היום|חצות היום|^חצות| חצות)/i, label: 'חצות היום', field: 'chatzot' },
  { re: /(מנחה גדולה)/i, label: 'מנחה גדולה', field: 'minchaGedola' },
  { re: /(מנחה קטנה)/i, label: 'מנחה קטנה', field: 'minchaKetana' },
  { re: /(פלג המנחה|פלג)/i, label: 'פלג המנחה', field: 'plagHaMincha' },
  { re: /(שקיעה|שקיעת החמה)/i, label: 'שקיעה', field: 'sunset' },
  { re: /(צאת הכוכבים|צאת השבת|מוצאי שבת|צאת כוכבים|צאת)/i, label: 'צאת הכוכבים', field: 'tzeit7083deg', rt: 'tzeit72min' },
];

// Returns true when the text is asking for a halachic time.
export function isZmanimQuestion(text) {
  const t = String(text || '');
  if (/(הדלקת נרות|זמן הדלקת|נרות שבת)/i.test(t)) return true;
  return ZMANIM.some(z => z.re.test(t)) &&
    // require a time-ish intent word to avoid matching unrelated chatter
    /(מתי|זמן|שעה|באיזו שעה|עד מתי|מה הזמן|מה השעה|סוף זמן|הזמן של)/i.test(t);
}

export function wantsCandleLighting(text) {
  return /(הדלקת נרות|זמן הדלקת|נרות שבת)/i.test(String(text || ''));
}

// Pick the location: an explicitly named city, else the default (Beit Shemesh).
export function resolveZmanimLocation(text) {
  const t = String(text || '');
  for (const c of CITIES) if (c.re.test(t)) return c;
  return DEFAULT_CITY;
}

// Which date: tomorrow if the caller said מחר, else today (Israel date).
export function resolveZmanimDate(text, now = new Date()) {
  const il = new Date(new Intl.DateTimeFormat('en-US', { timeZone: TZID, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now));
  if (/(מחר|למחר|מחרתיים)/i.test(String(text || ''))) {
    const days = /מחרתיים/i.test(String(text || '')) ? 2 : 1;
    il.setDate(il.getDate() + days);
  }
  const y = il.getFullYear(), m = String(il.getMonth() + 1).padStart(2, '0'), d = String(il.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Which zmanim were asked for (one or more). Empty → caller asked generally, so
// we return the headline daily zmanim.
export function selectRequestedZmanim(text) {
  const t = String(text || '');
  const picked = ZMANIM.filter(z => z.re.test(t));
  return picked.length ? picked : [];
}

function hhmm(iso) {
  if (!iso) return null;
  // Hebcal returns ISO8601 with the location's offset; read the wall-clock HH:MM
  // directly from the string so we never shift by the server's timezone.
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

// Fetch the day's zmanim from Hebcal. fetchImpl is injectable for tests.
export async function fetchZmanim(loc, date, fetchImpl = fetch) {
  const url = 'https://www.hebcal.com/zmanim?cfg=json&latitude=' + loc.lat + '&longitude=' + loc.lng +
    '&tzid=' + encodeURIComponent(TZID) + '&date=' + encodeURIComponent(date);
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Object.assign(new Error('Hebcal HTTP ' + r.status), { status: r.status });
  const data = await r.json();
  if (!data || !data.times) throw new Error('Hebcal returned no times');
  return data.times;
}

// Build the spoken Hebrew answer. Returns '' if nothing could be computed.
export function formatZmanimAnswer(times, { loc, date, requested, candles, text }) {
  const dateWord = /(מחר|למחר)/i.test(String(text || '')) ? 'מחר' : (/(מחרתיים)/i.test(String(text || '')) ? 'מחרתיים' : 'היום');
  const parts = [];
  if (candles) {
    const sunset = hhmm(times.sunset);
    if (sunset) {
      const [h, m] = sunset.split(':').map(Number);
      const total = h * 60 + m - (loc.candles || 20);
      const ch = String(Math.floor(((total % 1440) + 1440) % 1440 / 60)).padStart(2, '0');
      const cm = String(((total % 60) + 60) % 60).padStart(2, '0');
      parts.push('הדלקת נרות ב' + loc.name + ' ' + dateWord + ' היא בסביבות ' + ch + ':' + cm + ', לפי המנהג המקומי של כ' + (loc.candles || 20) + ' דקות לפני השקיעה בשעה ' + sunset);
    }
  }
  const list = requested && requested.length ? requested : ZMANIM.filter(z => ['sunrise', 'sofZmanShma', 'sofZmanTfilla', 'chatzot', 'sunset', 'tzeit7083deg'].includes(z.field));
  for (const z of list) {
    const t = hhmm(times[z.field]);
    if (!t) continue;
    let line = z.label + ' ' + t;
    if (z.mga && times[z.mga]) { const mg = hhmm(times[z.mga]); if (mg) line += ' לפי הגר"א, ולפי המגן אברהם ' + mg; }
    if (z.rt && times[z.rt]) { const rt = hhmm(times[z.rt]); if (rt) line += ', ולרבנו תם ' + rt; }
    parts.push(line);
  }
  if (!parts.length) return '';
  const where = 'ב' + loc.name;
  return 'הזמנים ' + where + ' ל' + dateWord + ': ' + parts.join('. ') + '. הזמנים מחושבים לפי הלוח האסטרונומי; למעשה לכו לפי מנהג המקום והרב שלכם.';
}

// Top-level: answer a zmanim question, or '' if not applicable / lookup failed.
export async function answerZmanimQuestion(text, { fetchImpl = fetch, now = new Date() } = {}) {
  if (!isZmanimQuestion(text)) return '';
  const loc = resolveZmanimLocation(text);
  const date = resolveZmanimDate(text, now);
  const requested = selectRequestedZmanim(text);
  const candles = wantsCandleLighting(text);
  const times = await fetchZmanim(loc, date, fetchImpl);
  return formatZmanimAnswer(times, { loc, date, requested, candles, text });
}
