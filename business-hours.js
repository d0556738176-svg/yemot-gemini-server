const TIME_RANGE = /\b\d{1,2}[:.]\d{2}\s*[-–—至]\s*\d{1,2}[:.]\d{2}\b/;

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isSuperPharmTarget(targets, question) {
  return /סופר\s*[-־]?\s*פארם|super.?pharm/i.test([...(targets || []), question].join(' '));
}

export function buildBusinessHoursQueries({ targets = [], locationText = '', city = '', area = '', pharmacy = false, question = '' } = {}) {
  const location = normalize(locationText);
  const cleanCity = normalize(city);
  const cleanArea = normalize(area);
  const businesses = targets.length ? targets : [isSuperPharmTarget([], question) ? 'סופר-פארם' : 'בית עסק'];
  const queries = [];

  for (const target of businesses) {
    const targetLocation = [target, cleanArea, cleanCity].filter(Boolean).join(' ');
    const variants = [
      targetLocation + ' שעות פתיחה סניף כתובת',
      targetLocation + ' שעות פעילות היום טלפון',
      targetLocation + ' אתר רשמי סניפים',
      targetLocation + ' שעות פתיחה מפה',
      target + ' ' + location + ' שעות פתיחה',
      target + ' ' + location + ' כתובת סניף שעות פעילות'
    ];
    queries.push(...variants);

    if (isSuperPharmTarget([target], question)) {
      queries.push(
        'site:super-pharm.co.il ' + [target, cleanArea, cleanCity].filter(Boolean).join(' ') + ' שעות פתיחה',
        'site:super-pharm.co.il ' + [cleanCity, cleanArea, 'סניפים סופר-פארם'].filter(Boolean).join(' ')
      );
    }
  }

  if (/ביג/i.test(area) && !city) {
    queries.push('סופר-פארם מתחם BIG שעות פתיחה כתובת סניף');
    queries.push('סופר פארם BIG Fashion שעות פתיחה');
  }
  if (pharmacy && /כללית/i.test(question)) {
    queries.push('כללית בית מרקחת ' + location + ' שעות פתיחה אתר רשמי');
  }

  // Search engines often normalize mall and city names differently. Keep both
  // the full location and separate area/city variants, without sending duplicates.
  return [...new Set(queries.map(normalize).filter(Boolean))].slice(0, 8);
}

function extractHoursEvidence(result) {
  const text = normalize([result?.title, result?.snippet].filter(Boolean).join(' | '));
  const match = text.match(TIME_RANGE);
  if (!match) return '';
  const start = Math.max(0, text.lastIndexOf('|', match.index) + 1);
  const endCandidates = [text.indexOf('|', match.index), text.indexOf('.', match.index + match[0].length)];
  const ends = endCandidates.filter(x => x >= 0);
  const end = ends.length ? Math.min(...ends) : Math.min(text.length, match.index + match[0].length + 90);
  return normalize(text.slice(start, end)).slice(0, 180);
}

function officialSuperPharm(result) {
  try {
    const host = new URL(String(result?.url || '')).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'super-pharm.co.il' || host.endsWith('.super-pharm.co.il');
  } catch {
    return false;
  }
}

export function buildBusinessHoursFallback({ question = '', business = 'הסניף', city = '', area = '', locationText = '', results = [] } = {}) {
  const q = normalize(question);
  const location = normalize(locationText || [area, city].filter(Boolean).join(' '));
  // BIG is a chain of shopping centers, not a unique branch identifier. Never guess
  // which Super-Pharm location the caller meant if no city or other specific area was spoken.
  if (/ביג/i.test(area) && !city) {
    return 'יש כמה מתחמי ביג בישראל, ואני לא רוצה למסור לך שעות של סניף אחר. באיזו עיר נמצא מתחם ביג שאליו אתה מתכוון?';
  }

  const matching = (results || []).filter(result => {
    const haystack = normalize([result?.title, result?.snippet, result?.url].join(' '))
      .toLowerCase().replace(/[״׳]/g, "'").replace(/[-־]/g, ' ');
    const target = /סופר\s*[-־]?\s*פארם|super.?pharm/i.test(business + ' ' + q);
    if (target && !/סופר\s*[-־]?\s*פארם|super.?pharm/i.test(haystack) && !officialSuperPharm(result)) return false;
    // Never substitute a different branch just because it is in the same city.
    // If the caller named a mall/neighborhood, require that location in the evidence.
    const normalizedArea = normalize(area).toLowerCase().replace(/[״׳]/g, "'").replace(/[-־]/g, ' ');
    const areaCore = normalizedArea.replace(/^(?:קניון|מתחם)\\s+/, '').trim();
    if (normalizedArea && !haystack.includes(normalizedArea) &&
        !(areaCore && haystack.includes(areaCore)) &&
        !(normalizedArea === 'ביג' && /\\bbig\\b|ביג/i.test(haystack))) return false;
    // City mentions are often omitted from search snippets; exact area match is stronger.
    if (city && !haystack.includes(city.toLowerCase()) && !normalizedArea) return false;
    if (/ביג/i.test(area) && !/(ביג|big)/i.test(haystack)) return false;
    return true;
  });
  const official = matching.find(result => officialSuperPharm(result) && extractHoursEvidence(result));
  if (official) {
    const hours = extractHoursEvidence(official);
    const branch = normalize(official.title || business);
    return 'מצאתי באתר הרשמי של סופר-פארם את פרטי הסניף ' + branch + '. שעות שמופיעות בתוצאת המקור: ' + hours + '. כדאי לוודא מול עמוד הסניף אם מדובר ביום חג או בשעות חריגות.';
  }
  if (matching.length) {
    const candidate = matching.find(result => normalize(result?.title)) || matching[0];
    const title = normalize(candidate.title);
    const snippet = normalize(candidate.snippet);
    const detail = snippet ? ' המידע הזמין בתוצאה הוא: ' + snippet.slice(0, 350) + '.' : '';
    return 'מצאתי תוצאה שעשויה להתאים ל' + business + (location ? ' באזור ' + location : '') + ': ' + title + '.' + detail + ' אבל לא נמצאו שעות פתיחה ברורות שאפשר לאמת, ולכן לא אנחש.';
  }
  if (!city && !area) {
    return 'מצאתי שלא צוין מיקום מספיק מדויק לסניף. באיזו עיר או באיזה מרכז קניות נמצא המקום?';
  }
  return 'חיפשתי את ' + business + (location ? ' באזור ' + location : '') + ', אבל המקורות שהתקבלו לא הציגו שעות פתיחה ברורות ומאומתות. אפשר לומר את שם העיר או הכתובת המדויקת כדי שאבדוק את הסניף הנכון.';
}
