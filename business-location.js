// Hebrew business-location parsing for branch 1. Keep this deterministic so it can
// be regression-tested without live search providers.
const CITIES = [
  'קריית שמונה','קרית שמונה','ראשון לציון','פתח תקווה','באר שבע','תל אביב יפו','תל אביב',
  'קריית גת','קרית גת','קירית גת','קריית-גת','קרית-גת','בית שמש','ביתר עילית','בני ברק','כפר סבא','רמת גן','גבעתיים',
  'ראש העין','מודיעין מכבים רעות','מודיעין','אור יהודה','יהוד','נס ציונה','יבנה',
  'רחובות','אשקלון','אשדוד','נתניה','הרצליה','רעננה','חולון','ירושלים','חיפה','עכו',
  'נצרת','קריית אתא','קרית אתא','עפולה','טבריה','צפת','אילת','לוד','רמלה','קריית אונו',
  'קרית אונו','גבעת שמואל','בת ים','באר יעקב','כרמיאל','נהריה','דימונה','ערד','אופקים',
  'שדרות','מעלה אדומים','בית שאן','פרדס חנה','זכרון יעקב','טירת כרמל','יקנעם','מגדל העמק'
];

const KNOWN_AREAS = [
  'רמות דוד','רמה א','רמה א׳','רמה ב','רמה ב׳','רמה ג','רמה ג׳','רמה ד','רמה ד׳','רמה ה','רמה ה׳',
  'רמת בית שמש','מרכז העיר','מגדל המים','נחם','גבעת שרת','גבעת משקף','נווה שמיר','המשקפיים',
  'כרמי גת','ביג','קניון עזריאלי','עזריאלי','קניון מלחה','קניון איילון','קניון הזהב'
];

function clean(value) {
  return String(value || '').replace(/[״׳]/g, "'").replace(/\s+/g, ' ').trim();
}

export function extractSearchCity(question) {
  const t = clean(question);
  return [...CITIES].sort((a, b) => b.length - a.length)
    .find(city => new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t)) || '';
}

export function extractLocalArea(question) {
  const t = clean(question);
  const known = [...KNOWN_AREAS].sort((a, b) => b.length - a.length)
    .find(area => t.toLowerCase().includes(area.toLowerCase()));
  if (known) return known;

  // Capture a spoken neighborhood, mall, shopping center, or commercial area.
  // Stop before the city, a question boundary, or the requested detail.
  const cityAlternation = [...CITIES].sort((a, b) => b.length - a.length)
    .map(city => city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(
    '(?:בשכונת|בשכונה|שכונת|באזור|באיזור|בקניון|לקניון|במתחם|במרכז הקניות|במרכז המסחרי)\\s+(.+?)(?=\\s+(?:ב|ל|מ)?(?:' + cityAlternation + ')(?=\\s|[,?.!]|$)|[,?.!]|\\s+(?:מה שעות|שעות פתיחה|שעות פעילות|מתי פתוח|מה הטלפון)\\b|$)',
    'i'
  );
  const match = t.match(re);
  if (!match) return '';
  let area = clean(match[1]).replace(/^(?:ה)?/, '');
  area = area.replace(/^(?:קניון|מתחם|שכונת|שכונה|אזור|איזור)\s+/i, '').trim();
  if (!area || area.length > 55) return '';
  return /קניון|מתחם|מרכז הקניות|מרכז מסחרי/i.test(match[0]) ? 'קניון ' + area.replace(/^קניון\s+/i, '') : area;
}

export function extractExplicitLocation(question) {
  const city = extractSearchCity(question);
  const area = extractLocalArea(question);
  return { city, area };
}
