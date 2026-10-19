const normalize = value => String(value || '')
  .toLowerCase()
  .replace(/[״׳]/g, "'")
  .replace(/[-־–—]/g, ' ')
  .replace(/[.,!?;:(){}]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const CITY_ALIASES = {
  'תל אביב': ['תל אביב', 'תל אביב יפו', 'תל אביב-יפו', 'תא', 'tel aviv'],
  'קריית גת': ['קריית גת', 'קרית גת', 'kiryat gat'],
  'קרית גת': ['קריית גת', 'קרית גת', 'kiryat gat'],
  'פתח תקווה': ['פתח תקווה', 'פתח תקוה', 'petah tikva']
};

export function isLocalBusinessDiscoveryRequest(question, location = {}) {
  const q = String(question || '');
  if (!location.area || !location.city) return false;
  if (/(?:שעות פתיחה|שעות פעילות|מתי פתוח|מתי נסגר|פתוח עכשיו|מספר טלפון|טלפון של|מוקד|שירות לקוחות)/i.test(q)) return false;
  return /(חנויות|חנות|עסקים|עסק|בתי עסק|מסעדות|מסעדה|מכולת|סופרמרקט|מרכז מסחרי|מקומות בשכונה|מה יש בשכונה|אילו מקומות)/i.test(q);
}

export function buildLocalBusinessQueries(question, { city = '', area = '' } = {}) {
  const q = String(question || '').replace(/\s+/g, ' ').trim();
  const category = /(מסעדות|מסעדה)/i.test(q) ? 'מסעדות' :
    /(מכולת|סופרמרקט|סופר)/i.test(q) ? 'מכולות וסופרמרקטים' :
    /(בתי מרקחת|בית מרקחת|פארם)/i.test(q) ? 'בתי מרקחת' : 'חנויות ועסקים';
  const queries = [
    q,
    [category, area, city].filter(Boolean).join(' '),
    [category, 'בשכונת', area, city].filter(Boolean).join(' '),
    [area, city, 'עסקים חנויות כתובות'].filter(Boolean).join(' '),
    'site:easy.co.il ' + [category, area, city].filter(Boolean).join(' '),
    'site:d.co.il ' + [category, area, city].filter(Boolean).join(' '),
    // If the neighborhood has no indexed directory pages, broaden to city-level
    // listings so the caller still gets useful leads, explicitly labelled as nearby.
    [category, city, 'חנויות עסקים כתובות טלפון'].filter(Boolean).join(' '),
    [city, 'מרכזים מסחריים חנויות עסקים'].filter(Boolean).join(' '),
    'site:easy.co.il ' + [category, city].filter(Boolean).join(' ')
  ];
  return [...new Set(queries.map(x => x.trim()).filter(Boolean))].slice(0, 9);
}

function cityMatch(text, city) {
  if (!city) return true;
  const normalizedText = normalize(text);
  const candidates = CITY_ALIASES[city] || [city];
  return candidates.some(candidate => normalizedText.includes(normalize(candidate)));
}

export function filterLocalBusinessResults(results, { city = '', area = '' } = {}) {
  const normalizedArea = normalize(area).replace(/^(?:קניון|מתחם)\s+/, '').trim();
  if (!city || !normalizedArea) return [];
  return (Array.isArray(results) ? results : []).filter(result => {
    const haystack = normalize([result?.title, result?.snippet, result?.url].join(' '));
    // Strict exact-neighborhood set: require both the requested locality and city.
    // City-level results are handled separately and never presented as inside the neighborhood.
    return haystack.includes(normalizedArea) && cityMatch(haystack, city);
  });
}

export function filterNearbyLocalBusinessResults(results, { city = '', area = '' } = {}) {
  if (!city) return [];
  const normalizedArea = normalize(area);
  return (Array.isArray(results) ? results : []).filter(result => {
    const title = String(result?.title || '').trim();
    const url = String(result?.url || '').trim();
    const haystack = normalize([title, result?.snippet, url].join(' '));
    if (!title || !url || !cityMatch(haystack, city)) return false;
    // Exclude generic search pages with no identifiable business/directory result.
    if (/^(?:חנויות ועסקים|חנויות|עסקים|מסעדות|מכולות וסופרמרקטים) (?:ב|של|ל)?\s*(?:קריית גת|קרית גת)$/i.test(normalize(title))) return false;
    // An exact match belongs in the exact set; this fallback is for city-level leads.
    return !normalizedArea || !haystack.includes(normalizedArea) || !cityMatch(haystack, city);
  });
}

export function buildNoVerifiedLocalResultsAnswer({ city = '', area = '' } = {}) {
  const location = [area, city].filter(Boolean).join(' ');
  return 'לא הצלחתי לאמת כרגע שמות של חנויות שנמצאות דווקא ב' + location +
    '. חיפשתי גם ברשימות עסקים של העיר, אבל אין לי כרגע תוצאה שאפשר לזהות בביטחון. לא אציג חנויות משכונה אחרת כאילו הן בתוך השכונה שביקשת.';
}
